/**
 * Browser client for an organization's own RPC endpoints. Server types are
 * imported as types only, so nothing server-side reaches the bundle.
 */

import type { z } from "zod";
import type { ChainResponse } from "@/app/api/chains/route";
import { OrgRpcErrorCode } from "@/lib/rpc/engine/org/codes";
import type { CoverageGap } from "@/lib/rpc/engine/org/coverage";
import type {
  createRpcConfigBody,
  updateRpcConfigBody,
} from "@/lib/rpc/engine/org/http";
import type {
  OrgRpcConfigView,
  OrgRpcPolicyView,
} from "@/lib/rpc/engine/org/service";
import type { RpcConfigVerification } from "@/lib/rpc/engine/org/url-slots";
import { RpcChainType } from "@/lib/rpc/engine/types";

export type CreateRpcConfigBody = z.input<typeof createRpcConfigBody>;
export type UpdateRpcConfigBody = z.input<typeof updateRpcConfigBody>;

/** A chain an organization can add endpoints for. */
export type RpcChainOption = {
  chainId: number;
  name: string;
  chainType: RpcChainType;
  isTestnet: boolean;
};

const ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(OrgRpcErrorCode)
);
const CHAIN_TYPES: ReadonlySet<string> = new Set(Object.values(RpcChainType));

/** A refused request, with what the route said about why. */
export class OrgRpcApiError extends Error {
  readonly status: number;
  readonly code: OrgRpcErrorCode | null;
  readonly verification: RpcConfigVerification | null;
  readonly gaps: CoverageGap[];

  constructor(
    status: number,
    message: string,
    details: {
      code?: OrgRpcErrorCode | null;
      verification?: RpcConfigVerification | null;
      gaps?: CoverageGap[];
    } = {}
  ) {
    super(message);
    this.name = "OrgRpcApiError";
    this.status = status;
    this.code = details.code ?? null;
    this.verification = details.verification ?? null;
    this.gaps = details.gaps ?? [];
  }
}

type ErrorBody = {
  error?: unknown;
  code?: unknown;
  verification?: unknown;
  gaps?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the route's `{ error, code, verification?, gaps? }` refusal. */
export function orgRpcErrorFrom(status: number, body: unknown): OrgRpcApiError {
  const parsed: ErrorBody = isObject(body) ? body : {};
  const message =
    typeof parsed.error === "string" && parsed.error.length > 0
      ? parsed.error
      : "Request failed";
  const code =
    typeof parsed.code === "string" && ERROR_CODES.has(parsed.code)
      ? (parsed.code as OrgRpcErrorCode)
      : null;
  return new OrgRpcApiError(status, message, {
    code,
    verification: isObject(parsed.verification)
      ? (parsed.verification as RpcConfigVerification)
      : null,
    gaps: Array.isArray(parsed.gaps) ? (parsed.gaps as CoverageGap[]) : [],
  });
}

async function call<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw orgRpcErrorFrom(response.status, body);
  }
  return body as T;
}

function configsPath(organizationId: string): string {
  return `/api/organizations/${encodeURIComponent(organizationId)}/rpc-configs`;
}

function configPath(organizationId: string, configId: string): string {
  return `${configsPath(organizationId)}/${encodeURIComponent(configId)}`;
}

/** Enabled chains of a type the engine serves, from the public chain list. */
export function toRpcChainOptions(
  chains: readonly ChainResponse[]
): RpcChainOption[] {
  const options: RpcChainOption[] = [];
  for (const chain of chains) {
    if (chain.isEnabled && CHAIN_TYPES.has(chain.chainType)) {
      options.push({
        chainId: chain.chainId,
        name: chain.name,
        chainType: chain.chainType as RpcChainType,
        isTestnet: chain.isTestnet,
      });
    }
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

export const orgRpcApi = {
  async listConfigs(organizationId: string): Promise<OrgRpcConfigView[]> {
    const data = await call<{ configs: OrgRpcConfigView[] }>(
      configsPath(organizationId)
    );
    return data.configs;
  },

  async createConfig(
    organizationId: string,
    body: CreateRpcConfigBody
  ): Promise<OrgRpcConfigView> {
    const data = await call<{ config: OrgRpcConfigView }>(
      configsPath(organizationId),
      { method: "POST", body: JSON.stringify(body) }
    );
    return data.config;
  },

  async updateConfig(
    organizationId: string,
    configId: string,
    body: UpdateRpcConfigBody
  ): Promise<OrgRpcConfigView> {
    const data = await call<{ config: OrgRpcConfigView }>(
      configPath(organizationId, configId),
      { method: "PATCH", body: JSON.stringify(body) }
    );
    return data.config;
  },

  async deleteConfig(organizationId: string, configId: string): Promise<void> {
    await call<{ deleted: true }>(configPath(organizationId, configId), {
      method: "DELETE",
    });
  },

  testConfig(
    organizationId: string,
    configId: string
  ): Promise<{ config: OrgRpcConfigView; allOk: boolean }> {
    return call(`${configPath(organizationId, configId)}/test`, {
      method: "POST",
    });
  },

  getPolicy(organizationId: string): Promise<OrgRpcPolicyView> {
    return call(
      `/api/organizations/${encodeURIComponent(organizationId)}/rpc-policy`
    );
  },

  setChainPolicy(
    organizationId: string,
    chainId: number,
    ownRpcOnly: boolean
  ): Promise<{ chainId: number; ownRpcOnly: boolean }> {
    return call(
      `/api/organizations/${encodeURIComponent(organizationId)}/rpc-policy`,
      { method: "PUT", body: JSON.stringify({ chainId, ownRpcOnly }) }
    );
  },

  async listChains(): Promise<RpcChainOption[]> {
    return toRpcChainOptions(await call<ChainResponse[]>("/api/chains"));
  },
};
