import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationRpcChainPolicy,
  organizationRpcConfigs,
} from "@/lib/db/schema-rpc";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { markOrganizationHost } from "@/lib/safe-fetch";
import { orgRpcConfigFromRow } from "../org/codec";
import type { OrgRpcConfig, OrgRpcPolicy, OrgRpcState } from "../types";
import { EMPTY_ORG_RPC_STATE, type OrgRpcSource } from "./org-source";

/** The organization's policy on one chain; no row means the defaults. */
export async function loadOrgRpcPolicy(
  organizationId: string,
  chainId: number
): Promise<OrgRpcPolicy> {
  const [row] = await db
    .select({ ownRpcOnly: organizationRpcChainPolicy.ownRpcOnly })
    .from(organizationRpcChainPolicy)
    .where(
      and(
        eq(organizationRpcChainPolicy.organizationId, organizationId),
        eq(organizationRpcChainPolicy.chainId, chainId)
      )
    )
    .limit(1);
  return { ownRpcOnly: row?.ownRpcOnly ?? false };
}

/** The chains on which the organization uses only its own endpoints. */
export async function loadOwnRpcOnlyChains(
  organizationId: string
): Promise<Set<number>> {
  const rows = await db
    .select({ chainId: organizationRpcChainPolicy.chainId })
    .from(organizationRpcChainPolicy)
    .where(
      and(
        eq(organizationRpcChainPolicy.organizationId, organizationId),
        eq(organizationRpcChainPolicy.ownRpcOnly, true)
      )
    );
  return new Set(rows.map((row) => row.chainId));
}

function markConfigHosts(config: OrgRpcConfig): void {
  for (const url of [
    config.httpPrimary,
    config.httpFallback,
    config.wssPrimary,
    config.wssFallback,
    config.privateTx,
  ]) {
    if (url) {
      markOrganizationHost(url.hostname);
    }
  }
}

/**
 * Decrypt every config of one organization on one chain. A config that
 * cannot be decrypted is left out, which fails closed: under own RPC only
 * its chain then reports as not covered instead of quietly using KeeperHub.
 */
export async function loadOrgRpcConfigs(
  organizationId: string,
  chainId?: number
): Promise<OrgRpcConfig[]> {
  const rows = await db
    .select()
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        chainId === undefined
          ? undefined
          : eq(organizationRpcConfigs.chainId, chainId)
      )
    );
  const configs: OrgRpcConfig[] = [];
  for (const row of rows) {
    try {
      const config = orgRpcConfigFromRow(row);
      markConfigHosts(config);
      configs.push(config);
    } catch (error) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[RPC Engine] Could not decrypt an organization RPC config",
        error,
        { organization_id: organizationId, config_id: row.id }
      );
    }
  }
  return configs;
}

function loadKey(organizationId: string, chainId: number): string {
  return `${organizationId}:${chainId}`;
}

async function readOrgRpcState(
  organizationId: string,
  chainId: number
): Promise<OrgRpcState> {
  const [policy, configs] = await Promise.all([
    loadOrgRpcPolicy(organizationId, chainId),
    loadOrgRpcConfigs(organizationId, chainId),
  ]);
  return configs.length === 0 && !policy.ownRpcOnly
    ? EMPTY_ORG_RPC_STATE
    : { policy, configs };
}

/**
 * Organization RPC state, read fresh on every call so a change made on any
 * instance applies everywhere at once: a stale copy could keep sending an
 * own-RPC-only chain to KeeperHub, or keep using a deleted config's URLs.
 * Concurrent reads of one organization and chain share a single query.
 */
export function createDbOrgRpcSource(): OrgRpcSource {
  const inFlight = new Map<string, Promise<OrgRpcState>>();
  return {
    load(organizationId: string, chainId: number): Promise<OrgRpcState> {
      const key = loadKey(organizationId, chainId);
      const pending = inFlight.get(key);
      if (pending) {
        return pending;
      }
      const next = readOrgRpcState(organizationId, chainId).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, next);
      return next;
    },
  };
}
