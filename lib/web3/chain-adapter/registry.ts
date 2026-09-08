import { getSolanaProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import { getGasStrategy } from "../gas-strategy";
import { getNonceManager } from "../nonce-manager";
import { EvmChainAdapter } from "./evm";
import { SolanaChainAdapter } from "./solana";
import type { ChainAdapter } from "./types";

const adapterCache = new Map<number, ChainAdapter>();

export function getChainAdapter(chainId: number): ChainAdapter {
  const cached = adapterCache.get(chainId);
  if (cached) {
    return cached;
  }

  let adapter: ChainAdapter;

  if (isSolanaChain(chainId)) {
    adapter = new SolanaChainAdapter(chainId, () =>
      getSolanaProvider({ chainId })
    );
  } else {
    adapter = new EvmChainAdapter(chainId, getGasStrategy(), getNonceManager());
  }

  adapterCache.set(chainId, adapter);
  return adapter;
}

export function clearChainAdapterCache(): void {
  adapterCache.clear();
}
