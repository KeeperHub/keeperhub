import "server-only";

import { ethers } from "ethers";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";

/**
 * Native-token USD pricing for the gas estimate shown in the confirm modal.
 *
 * Uses Chainlink's ETH/USD feeds directly (read-only on-chain). For every
 * supported chain we keep the feed address here and cache results for 60s
 * per (chainId). Chainlink aggregators return a signed int256 scaled by
 * `decimals()` (usually 8).
 */

const CHAINLINK_FEED_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)",
] as const;

/**
 * ETH/USD feed per chain. Native tokens on all our supported chains are ETH
 * or L2-ETH, so one feed per chain is enough for MVP.
 */
const NATIVE_USD_FEED: Readonly<Record<number, string>> = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
} as const;

type CachedPrice = {
  /** USD per 1 native token, as a decimal number with ~8 digits of precision */
  priceUsd: number;
  cachedAt: number;
};

const CACHE_TTL_MS = 60_000;
const priceCache = new Map<number, CachedPrice>();

/** Thin helper: returns the USD price of 1 native token on `chainId`. */
export async function getNativeUsdPrice(
  chainId: number
): Promise<number | null> {
  const cached = priceCache.get(chainId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.priceUsd;
  }

  const feedAddress = NATIVE_USD_FEED[chainId];
  if (!feedAddress) {
    return null;
  }

  try {
    const rpcUrl = getRpcUrlByChainId(chainId, "primary");
    const manager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
    const provider = manager.getProvider();
    const contract = new ethers.Contract(
      feedAddress,
      CHAINLINK_FEED_ABI,
      provider
    );
    const [answer, decimals] = (await Promise.all([
      contract.latestAnswer(),
      contract.decimals(),
    ])) as [bigint, bigint];
    if (answer <= BigInt(0)) {
      return null;
    }
    // Convert to a float with decimals.
    const asString = ethers.formatUnits(answer, Number(decimals));
    const asNumber = Number.parseFloat(asString);
    if (!Number.isFinite(asNumber)) {
      return null;
    }
    priceCache.set(chainId, {
      priceUsd: asNumber,
      cachedAt: Date.now(),
    });
    return asNumber;
  } catch {
    // Chainlink feed down or misconfigured — return null so callers can
    // display "gas: 0.0004 ETH (USD unavailable)" instead of erroring.
    return null;
  }
}

/**
 * Convert a wei cost to a USD number. Returns null when the price feed is
 * unavailable so callers can display an informative fallback.
 */
export async function weiToUsd(options: {
  chainId: number;
  amountWei: bigint;
}): Promise<number | null> {
  const price = await getNativeUsdPrice(options.chainId);
  if (price === null) {
    return null;
  }
  const amountNative = Number.parseFloat(ethers.formatEther(options.amountWei));
  if (!Number.isFinite(amountNative)) {
    return null;
  }
  return amountNative * price;
}
