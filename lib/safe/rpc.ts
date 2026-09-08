import "server-only";

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";

/**
 * Build an RpcProviderManager wired with both the chain's primary and
 * fallback endpoints so on-chain reads/writes survive a transient primary
 * outage. Single source of truth for the failover pattern across the Safe
 * surface (orchestrator install/update/reconcile, per-allowance edits,
 * the chain probes that decide signer mode, simulate / pre-deploy gas
 * fetching).
 *
 * Dedupes the fallback when it resolves to the same URL as primary so
 * the manager does not flap between two identical endpoints. Returns
 * the primary URL too so callers passing it to other Safe helpers
 * (signer init, transaction context) don't need to re-resolve it.
 */
export async function buildFailoverRpcManager(chainId: number): Promise<{
  rpcManager: Awaited<ReturnType<typeof getRpcProviderFromUrls>>;
  rpcUrl: string;
}> {
  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const fallbackRpcUrl = getRpcUrlByChainId(chainId, "fallback");
  const rpcManager = await getRpcProviderFromUrls(
    rpcUrl,
    fallbackRpcUrl === rpcUrl ? undefined : fallbackRpcUrl,
    chainId
  );
  return { rpcManager, rpcUrl };
}
