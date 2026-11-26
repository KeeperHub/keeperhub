import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationRpcChainPolicy,
  organizationRpcConfigs,
} from "@/lib/db/schema-rpc";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { orgRpcConfigFromRow } from "../org/codec";
import type { OrgRpcConfig, OrgRpcPolicy, OrgRpcState } from "../types";
import { EMPTY_ORG_RPC_STATE, type OrgRpcSource } from "./org-source";

const DEFAULT_TTL_MS = 30_000;

export type DbOrgRpcSourceOptions = {
  ttlMs?: number;
  now?: () => number;
};

export type CachedOrgRpcSource = OrgRpcSource & {
  /** Drop cached state for one organization after a write in this process. */
  invalidate(organizationId: string): void;
};

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
      configs.push(orgRpcConfigFromRow(row));
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

function cacheKey(organizationId: string, chainId: number): string {
  return `${organizationId}:${chainId}`;
}

/** Organization RPC state from the database, cached briefly per chain. */
export function createDbOrgRpcSource(
  options: DbOrgRpcSourceOptions = {}
): CachedOrgRpcSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    { at: number; organizationId: string; state: OrgRpcState }
  >();

  return {
    async load(organizationId: string, chainId: number): Promise<OrgRpcState> {
      const key = cacheKey(organizationId, chainId);
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) {
        return hit.state;
      }
      const [policy, configs] = await Promise.all([
        loadOrgRpcPolicy(organizationId, chainId),
        loadOrgRpcConfigs(organizationId, chainId),
      ]);
      const state: OrgRpcState =
        configs.length === 0 && !policy.ownRpcOnly
          ? EMPTY_ORG_RPC_STATE
          : { policy, configs };
      cache.set(key, { at: now(), organizationId, state });
      return state;
    },
    invalidate(organizationId: string): void {
      for (const [key, entry] of cache) {
        if (entry.organizationId === organizationId) {
          cache.delete(key);
        }
      }
    },
  };
}
