import "server-only";

import { STABLECOIN_CHAINLINK_FEEDS } from "@/lib/scan/adapters/protocol-registry";
import { decodeChainlinkAnswer } from "@/lib/scan/price/chainlink";
import { fetchDefillamaPrice } from "@/lib/scan/price/defillama";
import type { MulticallResult } from "@/lib/scan/types";

/**
 * Options for resolveUsdPrice.
 */
export interface ResolveUsdPriceOpts {
  /**
   * Pre-fetched Multicall3 result for the Chainlink latestRoundData call,
   * when the scanner orchestrator has already batched the Chainlink read
   * into the aggregate3 batch.  When absent, the Chainlink path is skipped
   * and DefiLlama is tried directly.
   */
  chainlinkResult?: MulticallResult;
}

/**
 * Resolves the current USD price for a token using a two-tier strategy:
 *
 *   1. Chainlink latestRoundData — when a registered feed exists for this
 *      chain + symbol AND a pre-fetched aggregate3 result is provided via
 *      `opts.chainlinkResult`.  This is the authoritative on-chain source
 *      for stablecoins; deviation from $1.00 is detected by `isDepegged`.
 *
 *   2. DefiLlama HTTP fallback — for tokens without a Chainlink feed, or
 *      when the Chainlink call failed or was not batched by the caller.
 *      Uses SSRF-guarded `safeFetch` internally (T-51-04-01).
 *
 *   3. null — when both sources miss.  A null price maps to `usdValue: null`
 *      ("N/A") at the call site — never a $0 guess (SCAN-09, T-51-04-02).
 *
 * @param chainId       - EVM chain ID
 * @param tokenAddress  - ERC-20 contract address
 * @param symbol        - Token symbol used to look up Chainlink feed registry
 * @param opts          - Optional pre-fetched Chainlink aggregate3 result
 */
export async function resolveUsdPrice(
  chainId: number,
  tokenAddress: string,
  symbol: string,
  opts: ResolveUsdPriceOpts = {}
): Promise<number | null> {
  // Chainlink first — only when a feed is registered for this chain + symbol
  const feedAddress = STABLECOIN_CHAINLINK_FEEDS[chainId]?.[symbol];
  if (feedAddress !== undefined && opts.chainlinkResult?.success === true) {
    const price = decodeChainlinkAnswer(opts.chainlinkResult.returnData, 8);
    if (price !== null) {
      return price;
    }
  }

  // DefiLlama fallback for tokens without a Chainlink feed and as secondary
  // fallback when Chainlink returned a bad answer or was not batched (SCAN-09)
  return (await fetchDefillamaPrice(chainId, tokenAddress)) ?? null;
}
