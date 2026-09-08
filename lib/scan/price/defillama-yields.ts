import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import {
  AAVE_V3_POOLS,
  SKY_SAVINGS,
  SPARK_POOLS,
} from "@/lib/scan/adapters/protocol-registry";
import type { ApyContext, ApyEntry } from "@/lib/scan/suggestions/engine";
import type { StablecoinBalance } from "@/lib/scan/types";

/**
 * Chain name map for the DefiLlama yields API (`yields.llama.fi/pools`).
 *
 * IMPORTANT: these differ from DEFILLAMA_CHAIN_SLUGS (coins API uses lowercase;
 * the yields API uses title-case). Optimism is "OP Mainnet" in the yields API,
 * not "Optimism" — using the wrong value silently returns zero pools for
 * chainId 10 (Pitfall 1 in 57-RESEARCH).
 *
 * [VERIFIED: live yields.llama.fi/pools 2026-06-30]
 */
export const DEFILLAMA_YIELDS_CHAIN_SLUGS: Record<number, string> = {
  1: "Ethereum",
  10: "OP Mainnet",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
};

/**
 * A single pool record from the DefiLlama yields API (`yields.llama.fi/pools`).
 *
 * Key fields for filtering and ranking:
 *   - `pool`  — internal DefiLlama UUID, NOT a contract address.
 *   - `apy`   — total APY (apyBase + apyReward); always rank/display on this.
 *   - `underlyingTokens` — ERC-20 addresses; use for project-agnostic matching.
 *
 * [VERIFIED: live yields.llama.fi/pools 2026-06-30]
 */
export type DefillamaYieldsPool = {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  underlyingTokens: string[];
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const APY_FETCH_TIMEOUT_MS = 4000;
const YIELDS_CACHE_TTL_MS = 15 * 60 * 1000;
const YIELDS_URL = "https://yields.llama.fi/pools";

/**
 * Upper bound (in percent) on an acceptable DefiLlama `apy`. The feed is
 * untrusted: a malformed value or transient incentive spike (e.g. apy: 5000,
 * or >= 1e21 which toFixed(1) renders in exponential notation) would be ranked
 * as "best" and shown verbatim. Anything above this ceiling is treated as
 * malformed and excluded so the user never sees an absurd headline rate.
 */
const APY_MAX_PLAUSIBLE = 1000;

/**
 * USDC/USDT project allowlist for yield ranking (YIELD-02).
 *
 * "sky-lending" is EXCLUDED: it has no USDC/USDT supply pools — only SUSDS
 * pools for the USDS->sUSDS pinned case (Pitfall 7 in 57-RESEARCH).
 * "spark" (bare) is EXCLUDED: the correct slug is "sparklend" or "spark-savings"
 * (Pitfall 2 in 57-RESEARCH -- verified from live yields.llama.fi/pools).
 *
 * [VERIFIED: live yields.llama.fi/pools 2026-06-30]
 */
const USDC_USDT_ALLOWLIST = new Set([
  "aave-v3",
  "aave-v4",
  "sparklend",
  "spark-savings",
  "morpho-blue",
]);

const SKY_SLUG = "sky-lending";
const SKY_SYMBOL = "SUSDS";

// ---------------------------------------------------------------------------
// Module-level cache (single-entry for the full pools snapshot)
// ---------------------------------------------------------------------------

type ApyCacheEntry = {
  pools: DefillamaYieldsPool[];
  fetchedAt: number;
};

let _apyCache: ApyCacheEntry | null = null;

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Fetches all yield pools from DefiLlama (`yields.llama.fi/pools`).
 *
 * Uses a module-level 15-minute in-process cache to avoid repeated ~4MB
 * fetches. Returns [] on any failure (timeout, non-ok response, parse error)
 * so callers degrade gracefully to generic copy (YIELD-03).
 *
 * Timeout: 4s via AbortController, matching the per-chain scan timeout.
 */
export async function fetchDefillamaYieldPools(): Promise<
  DefillamaYieldsPool[]
> {
  const now = Date.now();
  if (_apyCache !== null && now - _apyCache.fetchedAt < YIELDS_CACHE_TTL_MS) {
    return _apyCache.pools;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APY_FETCH_TIMEOUT_MS);
  try {
    const resp = await safeFetch(YIELDS_URL, {
      plugin: "scan-defillama-yields",
      signal: controller.signal as RequestInit["signal"],
    });
    if (!resp.ok) {
      return [];
    }
    const data = (await resp.json()) as { data: DefillamaYieldsPool[] };
    const pools = data.data ?? [];
    // Only cache non-empty snapshots. A successful-but-empty response
    // (`{ data: [] }` or a missing `data`) is a transient upstream blip; caching
    // it would pin every user to generic copy for the full TTL even after
    // DefiLlama recovers. Leaving the cache unset lets the next scan re-fetch.
    if (pools.length > 0) {
      _apyCache = { pools, fetchedAt: now };
    }
    return pools;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the ApyContext lookup from a pre-fetched pool snapshot and the
 * stablecoins detected in the current scan.
 *
 * USDS is pinned to sky-lending SUSDS (YIELD-01).
 * USDC/USDT are ranked by max total APY across the USDC_USDT_ALLOWLIST with
 * a TVL >= $10M floor and a TVL tie-break on equal APY (YIELD-02).
 *
 * Malformed entries (non-finite apy/tvlUsd, missing chain, etc.) are skipped
 * without throwing (YIELD-03 graceful-degrade contract).
 */
export function buildApyContext(
  pools: DefillamaYieldsPool[],
  stablecoins: StablecoinBalance[]
): ApyContext {
  const map = new Map<string, ApyEntry>();

  for (const stable of stablecoins) {
    const chainSlug = DEFILLAMA_YIELDS_CHAIN_SLUGS[stable.chainId];
    if (!chainSlug) {
      continue;
    }

    const isUsds = stable.symbol === "USDS";
    const candidates: DefillamaYieldsPool[] = [];

    for (const p of pools) {
      if (p.chain !== chainSlug) {
        continue;
      }
      if (!p.stablecoin) {
        continue;
      }
      if (p.ilRisk !== "no") {
        continue;
      }
      if (p.exposure !== "single") {
        continue;
      }
      if (!Number.isFinite(p.tvlUsd) || p.tvlUsd < 10_000_000) {
        continue;
      }
      // Reject non-finite, non-positive, and implausibly large APY values
      // (untrusted source — see APY_MAX_PLAUSIBLE).
      if (!Number.isFinite(p.apy) || p.apy <= 0 || p.apy > APY_MAX_PLAUSIBLE) {
        continue;
      }
      // YIELD-03: the engine displays this rate as p.apy.toFixed(1), so any
      // APY that rounds to 0.0 at one decimal (sub-0.05%) would render as
      // "~0.0% APY". Drop such pools here so the only entries that survive
      // have a showable rate and the engine degrades them to generic copy.
      if (Number.parseFloat(p.apy.toFixed(1)) <= 0) {
        continue;
      }

      if (isUsds) {
        if (p.project !== SKY_SLUG || p.symbol !== SKY_SYMBOL) {
          continue;
        }
      } else if (!USDC_USDT_ALLOWLIST.has(p.project)) {
        continue;
      }

      // underlyingTokens is untrusted: a non-string element (null, number)
      // would throw on .toLowerCase() and abort buildApyContext for the WHOLE
      // scan. Type-guard each element so one bad pool is skipped, not fatal.
      const underlyingMatch = (p.underlyingTokens ?? []).some(
        (t) =>
          typeof t === "string" &&
          t.toLowerCase() === stable.tokenAddress.toLowerCase()
      );
      if (!underlyingMatch) {
        continue;
      }

      candidates.push(p);
    }

    let best: DefillamaYieldsPool | null = null;
    for (const pool of candidates) {
      if (best === null) {
        best = pool;
      } else if (pool.apy > best.apy) {
        best = pool;
      } else if (pool.apy === best.apy && pool.tvlUsd > best.tvlUsd) {
        best = pool;
      }
    }

    if (!best) {
      continue;
    }

    const key = `${stable.symbol.toLowerCase()}:${stable.chainId}`;
    map.set(key, {
      apy: best.apy,
      projectLabel: projectSlugToLabel(best.project),
      destinationAddress: resolveDestinationAddress(
        best.project,
        stable.chainId
      ),
    });
  }

  return {
    getBestYield: (symbol: string, chainId: number): ApyEntry | null =>
      map.get(`${symbol.toLowerCase()}:${chainId}`) ?? null,
  };
}

/**
 * Returns a human-readable label for a DefiLlama project slug.
 *
 * The network is intentionally NOT included: the suggestion card renders a
 * separate chain pill, so repeating the chain in the venue label would be
 * redundant.
 *
 * Examples:
 *   projectSlugToLabel("sky-lending")  -> "Sky Savings (sUSDS)"
 *   projectSlugToLabel("aave-v3")      -> "Aave V3"
 *   projectSlugToLabel("morpho-blue")  -> "Morpho Blue"
 */
export function projectSlugToLabel(slug: string): string {
  switch (slug) {
    case "sky-lending":
      return "Sky Savings (sUSDS)";
    case "aave-v3":
      return "Aave V3";
    case "aave-v4":
      return "Aave V4";
    case "sparklend":
      return "SparkLend";
    case "spark-savings":
      return "Spark Savings";
    case "morpho-blue":
      return "Morpho Blue";
    default:
      return slug;
  }
}

/**
 * Resets the module-level APY pool cache.
 *
 * Exported for test isolation — call in beforeEach to prevent cache state
 * from leaking between test cases.
 */
export function clearApyCache(): void {
  _apyCache = null;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the on-chain contract address from the existing protocol registry
 * for a given project slug and chain. Returns null for protocols not yet in
 * the registry (aave-v4, morpho-blue) — these show label-only copy in
 * confirmInputs (T-57-04 accepted).
 *
 * Never uses the DefiLlama `pool` UUID field — that is an internal UUID, not
 * a contract address (Pitfall 4 in 57-RESEARCH).
 */
function resolveDestinationAddress(
  projectSlug: string,
  chainId: number
): string | null {
  switch (projectSlug) {
    case "sky-lending":
      return SKY_SAVINGS[chainId]?.sUSDS ?? null;
    case "aave-v3":
      return AAVE_V3_POOLS[chainId] ?? null;
    case "sparklend":
    case "spark-savings":
      return SPARK_POOLS[chainId] ?? null;
    case "aave-v4":
    case "morpho-blue":
      return null;
    default:
      return null;
  }
}
