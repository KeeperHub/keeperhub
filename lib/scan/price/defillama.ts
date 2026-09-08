import "server-only";

import { safeFetch } from "@/lib/safe-fetch";

/**
 * Per-request timeout for the DefiLlama price fetch.
 *
 * The pricing passes run inside `scanOneChain`, which is raced against the 4s
 * per-chain wall-clock budget (CHAIN_TIMEOUT_MS in lib/scan/scan-chains.ts).
 * safeFetch inherits undici's default timeouts (effectively minutes), so
 * without an explicit bound a single slow coins.llama.fi response would burn
 * the whole chain budget and drop every protocol's positions on that chain.
 * Capping the fetch degrades a pricing stall to `usdValue: null` (a
 * first-class state) instead of losing the chain.
 */
const DEFILLAMA_FETCH_TIMEOUT_MS = 2500;

/**
 * DefiLlama chain slug map for the `coins.llama.fi/prices/current` API.
 *
 * DefiLlama uses its own slug convention (not EVM chain IDs or standard
 * network names).  Tokens on chains absent from this map resolve to null
 * (N/A) rather than a $0 guess — DefiLlama cannot be queried without a
 * valid slug (Pitfall 6 in RESEARCH: slug mismatch produces empty response
 * with no error).
 */
export const DEFILLAMA_CHAIN_SLUGS: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  4217: "tempo",
};

type DefillamaCoinsResponse = {
  coins: Record<
    string,
    { price: number; decimals: number; symbol: string; timestamp: number }
  >;
};

/**
 * Fetches the current USD price of a token from DefiLlama's coins API.
 *
 * Uses `safeFetch` (SSRF-guarded) for the outbound request (T-51-04-01).
 * The URL is a fixed public host; the only variable is the token address
 * path segment (lowercased — not user-supplied raw input).
 *
 * Returns null on any failure — an API outage or an unsupported chain
 * degrades gracefully to "N/A", never to $0 (SCAN-09, T-51-04-02).
 *
 * @param chainId      - EVM chain ID (must be in DEFILLAMA_CHAIN_SLUGS)
 * @param tokenAddress - ERC-20 token contract address (checksummed or not)
 */
export async function fetchDefillamaPrice(
  chainId: number,
  tokenAddress: string
): Promise<number | null> {
  const chainSlug = DEFILLAMA_CHAIN_SLUGS[chainId];
  if (chainSlug === undefined) {
    return null;
  }

  const coinId = `${chainSlug}:${tokenAddress.toLowerCase()}`;
  const url = `https://coins.llama.fi/prices/current/${coinId}`;

  try {
    const resp = await safeFetch(url, {
      plugin: "scan-defillama",
      signal: AbortSignal.timeout(DEFILLAMA_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as DefillamaCoinsResponse;
    return data.coins[coinId]?.price ?? null;
  } catch {
    return null;
  }
}
