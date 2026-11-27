import { rpc } from "@/lib/rpc/engine";
import { type RpcScope, RpcScopeKind } from "@/lib/rpc/engine/types";
import { BoundedCache } from "@/lib/rpc/providers/bounded-cache";
import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { getGasStrategy } from "../gas-strategy";
import { getNonceManager } from "../nonce-manager";
import { EvmChainAdapter } from "./evm";
import { SolanaChainAdapter } from "./solana";
import type { ChainAdapter } from "./types";

// One Solana adapter per organization, selection and chain, so the cache is
// bounded; an adapter holds no connection of its own, so dropping one is free.
const ADAPTER_CACHE_LIMIT = 1000;
const adapterCache = new BoundedCache<ChainAdapter>(ADAPTER_CACHE_LIMIT);

/** Who the adapter's RPC traffic belongs to; EVM adapters take theirs per call. */
function scopeKey(scope: RpcScope): string {
  return scope.kind === RpcScopeKind.ORG
    ? JSON.stringify([scope.organizationId, scope.selection])
    : JSON.stringify([scope.purpose]);
}

/**
 * The adapter for a chain. EVM adapters are handed their RPC manager on each
 * call; Solana adapters reach the RPC themselves, so they are kept per scope
 * and resolve their route through the engine.
 */
export function getChainAdapter(
  chainId: number,
  scope: RpcScope
): ChainAdapter {
  const solana = isSolanaChain(chainId);
  const key = solana
    ? JSON.stringify([chainId, scopeKey(scope)])
    : String(chainId);
  const cached = adapterCache.get(key);
  if (cached) {
    return cached;
  }

  const adapter: ChainAdapter = solana
    ? new SolanaChainAdapter(chainId, async () => {
        const client = await rpc.solana(scope, chainId);
        return client.manager;
      })
    : new EvmChainAdapter(chainId, getGasStrategy(), getNonceManager());

  adapterCache.set(key, adapter);
  return adapter;
}

export function clearChainAdapterCache(): void {
  adapterCache.clear();
}
