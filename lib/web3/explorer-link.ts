import "server-only";

import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  buildChainAddressUrl,
  buildChainTransactionUrl,
} from "@/lib/web3/chain-adapter/explorer";

/**
 * Resolve the block-explorer link for an address or transaction hash on a
 * network, using the cached explorer-config lookup. Non-critical by design:
 * any failure (unknown network, missing explorer config, DB error) resolves
 * to undefined so callers log without the link.
 */
export async function resolveExplorerLink(
  network: string,
  value: string,
  kind: "address" | "transaction" = "address"
): Promise<string | undefined> {
  try {
    const chainId = getChainIdFromNetwork(network);
    const url =
      kind === "transaction"
        ? await buildChainTransactionUrl(chainId, value)
        : await buildChainAddressUrl(chainId, value);
    return url || undefined;
  } catch {
    // Non-critical: if lookup fails, callers proceed without the link
    return undefined;
  }
}
