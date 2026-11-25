import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { type Chain, chains } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SecretUrl } from "../secret-url";
import { type PlatformEndpoints, type RpcChain, RpcChainType } from "../types";

export type PlatformChainRecord = {
  chain: RpcChain;
  endpoints: PlatformEndpoints;
};

/** KeeperHub's own endpoints per chain. */
export type PlatformRpcSource = {
  load(chainId: number): Promise<PlatformChainRecord | null>;
};

type ChainRow = Pick<
  Chain,
  | "chainId"
  | "name"
  | "chainType"
  | "isEnabled"
  | "defaultPrimaryRpc"
  | "defaultFallbackRpc"
  | "defaultPrimaryWss"
  | "defaultFallbackWss"
  | "usePrivateMempoolRpc"
  | "defaultPrivateRpcUrl"
>;

/** Map a `chains` row to the engine's shape. Throws on a malformed URL. */
export function platformRecordFromChainRow(row: ChainRow): PlatformChainRecord {
  return {
    chain: {
      chainId: row.chainId,
      name: row.name,
      chainType:
        row.chainType === RpcChainType.SOLANA
          ? RpcChainType.SOLANA
          : RpcChainType.EVM,
      isEnabled: row.isEnabled ?? false,
    },
    endpoints: {
      httpPrimary: SecretUrl.parse(row.defaultPrimaryRpc),
      httpFallback: SecretUrl.parseOptional(row.defaultFallbackRpc),
      wssPrimary: SecretUrl.parseOptional(row.defaultPrimaryWss),
      wssFallback: SecretUrl.parseOptional(row.defaultFallbackWss),
      privateTx: row.usePrivateMempoolRpc
        ? SecretUrl.parseOptional(row.defaultPrivateRpcUrl)
        : undefined,
    },
  };
}

export type DbPlatformRpcSourceOptions = {
  ttlMs?: number;
  now?: () => number;
};

export type CachedPlatformRpcSource = PlatformRpcSource & {
  clear(): void;
};

const DEFAULT_TTL_MS = 30_000;

/**
 * Reads the `chains` table, which deploys seed from the environment's chain
 * config. Rows are cached briefly: they change only on deploy or by admin
 * edit, and every RPC call would otherwise cost a query.
 */
export function createDbPlatformRpcSource(
  options: DbPlatformRpcSourceOptions = {}
): CachedPlatformRpcSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<
    number,
    { at: number; record: PlatformChainRecord | null }
  >();

  async function read(chainId: number): Promise<PlatformChainRecord | null> {
    const rows = await db
      .select()
      .from(chains)
      .where(eq(chains.chainId, chainId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    try {
      return platformRecordFromChainRow(row);
    } catch (error) {
      logSystemError(
        ErrorCategory.CONFIGURATION,
        `[RPC Engine] Chain ${chainId} has a malformed RPC URL`,
        error,
        { chain_id: String(chainId) }
      );
      return null;
    }
  }

  return {
    async load(chainId: number): Promise<PlatformChainRecord | null> {
      const hit = cache.get(chainId);
      if (hit && now() - hit.at < ttlMs) {
        return hit.record;
      }
      const record = await read(chainId);
      cache.set(chainId, { at: now(), record });
      return record;
    },
    clear(): void {
      cache.clear();
    },
  };
}
