import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";

/**
 * The manager for reads beside a send that carry no transaction data (token
 * decimals, symbol, balance; the trace of a mined transaction). A private
 * relay such as Flashbots Protect refuses eth_call and debug_traceTransaction,
 * so those go to the chain's public RPC; the transaction itself never does.
 */
export function readRpcFor(
  sendRpc: RpcProviderManager,
  options: { chainId: number; userId?: string }
): Promise<RpcProviderManager> {
  if (!sendRpc.hasPrivateRelayPrimary()) {
    return Promise.resolve(sendRpc);
  }
  return getRpcProvider({ chainId: options.chainId, userId: options.userId });
}
