import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import { DEFILLAMA_CHAIN_SLUGS } from "@/lib/scan/price/defillama";

const FETCH_TIMEOUT_MS = 4000;
const MAX_COINS = 60;

/** DefiLlama's stand-in for a chain's own coin. */
const NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000";

export type PriceRequest = {
  chainId: number;
  /** Absent for the chain's native coin. */
  tokenAddress?: string;
};

type DefillamaCoinsResponse = {
  coins?: Record<string, { price?: number }>;
};

/** The key both sides of the wire agree on for one asset. */
export function priceKey(chainId: number, tokenAddress?: string): string {
  return `${chainId}:${(tokenAddress ?? NATIVE_SENTINEL).toLowerCase()}`;
}

function coinId(request: PriceRequest): string | null {
  const slug = DEFILLAMA_CHAIN_SLUGS[request.chainId];
  if (!slug) {
    return null;
  }
  return `${slug}:${(request.tokenAddress ?? NATIVE_SENTINEL).toLowerCase()}`;
}

/**
 * Current USD prices for a batch of assets, as one upstream call.
 *
 * An asset DefiLlama does not know about is left out of the result rather
 * than priced at zero: a wallet total has to be able to say what it could
 * not account for instead of quietly understating itself.
 */
export async function fetchAssetPrices(
  requests: PriceRequest[]
): Promise<Record<string, number>> {
  const byCoinId = new Map<string, string[]>();
  for (const request of requests.slice(0, MAX_COINS)) {
    const id = coinId(request);
    if (!id) {
      continue;
    }
    const keys = byCoinId.get(id) ?? [];
    keys.push(priceKey(request.chainId, request.tokenAddress));
    byCoinId.set(id, keys);
  }
  if (byCoinId.size === 0) {
    return {};
  }

  const url = `https://coins.llama.fi/prices/current/${[...byCoinId.keys()].join(",")}`;
  try {
    const response = await safeFetch(url, {
      plugin: "wallet-asset-prices",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {};
    }
    const data = (await response.json()) as DefillamaCoinsResponse;
    const prices: Record<string, number> = {};
    for (const [id, keys] of byCoinId) {
      const price = data.coins?.[id]?.price;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        continue;
      }
      for (const key of keys) {
        prices[key] = price;
      }
    }
    return prices;
  } catch {
    return {};
  }
}
