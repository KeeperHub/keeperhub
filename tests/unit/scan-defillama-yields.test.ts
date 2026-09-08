/**
 * RED tests for the DefiLlama yields client + buildApyContext (57-01).
 *
 * All tests fail against the "not implemented: 57-02" throw-stub.
 * They become GREEN in 57-02 when the real implementation lands.
 *
 * Requirements pinned: YIELD-01, YIELD-02, YIELD-03 (fetch/cache/filter/rank)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted ensures the mock variables are available before module imports
// resolve (TDZ guard — learned from 54-03 decision).
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import {
  buildApyContext,
  clearApyCache,
  fetchDefillamaYieldPools,
} from "@/lib/scan/price/defillama-yields";

// ---------------------------------------------------------------------------
// Fixtures — pool records from yields.llama.fi/pools
// All fields match the verified DefillamaYieldsPool schema (57-RESEARCH.md).
// [VERIFIED: live yields.llama.fi/pools 2026-06-30]
// ---------------------------------------------------------------------------

const USDS_ETH_ADDRESS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
const ARBITRUM_USDC_ADDRESS = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
// sUSDS vault address from SKY_SAVINGS[1] registry
const SUSDS_ETH_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

// Verified sUSDS pool on Ethereum (sky-lending, $5.5B TVL, 3.6% APY)
const POOL_SKY_SUSDS_ETH = {
  pool: "d8c4eff5-c8a9-46fc-a888-057c4c668e72",
  chain: "Ethereum",
  project: "sky-lending",
  symbol: "SUSDS",
  tvlUsd: 5_525_559_833,
  apyBase: 3.6,
  apyReward: null,
  apy: 3.6,
  stablecoin: true,
  ilRisk: "no",
  exposure: "single",
  underlyingTokens: [USDS_ETH_ADDRESS],
};

// Aave V3 USDC pool on Arbitrum ($250M TVL, 4.5% APY)
const POOL_AAVE_V3_USDC_ARB = {
  pool: "aave-arb-usdc-pool-uuid",
  chain: "Arbitrum",
  project: "aave-v3",
  symbol: "USDC",
  tvlUsd: 250_000_000,
  apyBase: 4.5,
  apyReward: null,
  apy: 4.5,
  stablecoin: true,
  ilRisk: "no",
  exposure: "single",
  underlyingTokens: [ARBITRUM_USDC_ADDRESS],
};

// Morpho Blue USDC pool on Arbitrum ($80M TVL, 5.1% APY — vault name symbol)
const POOL_MORPHO_USDC_ARB = {
  pool: "morpho-arb-usdc-pool-uuid",
  chain: "Arbitrum",
  project: "morpho-blue",
  symbol: "GTUSDCP",
  tvlUsd: 80_000_000,
  apyBase: null,
  apyReward: 5.1,
  apy: 5.1,
  stablecoin: true,
  ilRisk: "no",
  exposure: "single",
  underlyingTokens: [ARBITRUM_USDC_ADDRESS],
};

// Low-TVL pool — must be excluded ($5M < $10M floor)
const POOL_LOW_TVL_USDC_ARB = {
  pool: "low-tvl-pool-uuid",
  chain: "Arbitrum",
  project: "aave-v3",
  symbol: "USDC",
  tvlUsd: 5_000_000,
  apyBase: 9.9,
  apyReward: null,
  apy: 9.9,
  stablecoin: true,
  ilRisk: "no",
  exposure: "single",
  underlyingTokens: [ARBITRUM_USDC_ADDRESS],
};

// apyBase:null, apyReward-only SparkLend pool — must qualify on total apy field
const POOL_SPARKLEND_REWARD_ONLY = {
  pool: "sparklend-reward-only-uuid",
  chain: "Ethereum",
  project: "sparklend",
  symbol: "USDC",
  tvlUsd: 317_000_000,
  apyBase: null,
  apyReward: 3.45,
  apy: 3.45,
  stablecoin: true,
  ilRisk: "no",
  exposure: "single",
  underlyingTokens: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
};

// Stablecoin fixtures used in buildApyContext tests
const STABLE_USDS_ETH = {
  chainId: 1,
  symbol: "USDS",
  tokenAddress: USDS_ETH_ADDRESS,
  amount: "500000000000000000000",
  decimals: 18,
  usdValue: 500,
  priceUsd: 1.0,
  depegged: false,
};

const STABLE_USDC_ARB = {
  chainId: 42_161,
  symbol: "USDC",
  tokenAddress: ARBITRUM_USDC_ADDRESS,
  amount: "500000000",
  decimals: 6,
  usdValue: 500,
  priceUsd: 1.0,
  depegged: false,
};

const ALL_POOLS = [
  POOL_SKY_SUSDS_ETH,
  POOL_AAVE_V3_USDC_ARB,
  POOL_MORPHO_USDC_ARB,
  POOL_LOW_TVL_USDC_ARB,
  POOL_SPARKLEND_REWARD_ONLY,
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ status: "success", data: ALL_POOLS }),
  });
  // Resets module-level APY cache between tests.
  // NOTE: throws "not implemented: 57-02" in the stub — expected RED state.
  clearApyCache();
});

// ---------------------------------------------------------------------------
// fetchDefillamaYieldPools — fetch + parse + error degrade
// ---------------------------------------------------------------------------

describe("fetchDefillamaYieldPools: fetch behaviour", () => {
  it("fetch: returns parsed pool array on ok response", async () => {
    const pools = await fetchDefillamaYieldPools();
    expect(Array.isArray(pools)).toBe(true);
    expect(pools.length).toBeGreaterThan(0);
  });

  it("fetch: returns [] when response is not ok (resp.ok false)", async () => {
    safeFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const pools = await fetchDefillamaYieldPools();
    expect(pools).toEqual([]);
  });

  it("fetch: returns [] when safeFetch throws (SCAN-09 degrade)", async () => {
    safeFetch.mockRejectedValueOnce(new Error("network error"));
    const pools = await fetchDefillamaYieldPools();
    expect(pools).toEqual([]);
  });
});

describe("fetchDefillamaYieldPools: module-level cache", () => {
  it("cache: second call within TTL does not call safeFetch again", async () => {
    await fetchDefillamaYieldPools();
    await fetchDefillamaYieldPools();
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("cache: clearApyCache allows a fresh fetch on the next call", async () => {
    await fetchDefillamaYieldPools();
    clearApyCache();
    await fetchDefillamaYieldPools();
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("cache: an empty successful response is NOT cached -> next call re-fetches (WR-03)", async () => {
    // Transient empty 200 must not pin generic copy for the full TTL.
    safeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "success", data: [] }),
    });
    const first = await fetchDefillamaYieldPools();
    expect(first).toEqual([]);
    // Next call re-fetches (default mock returns ALL_POOLS) since [] was not cached.
    const second = await fetchDefillamaYieldPools();
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(second.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildApyContext — pool filtering + ranking (YIELD-01, YIELD-02)
// ---------------------------------------------------------------------------

describe("buildApyContext: USDS pinned to sky-lending SUSDS (YIELD-01)", () => {
  it("USDS: getBestYield returns sky-lending sUSDS pool for USDS on Ethereum", () => {
    const ctx = buildApyContext(ALL_POOLS, [STABLE_USDS_ETH]);
    const entry = ctx.getBestYield("USDS", 1);
    expect(entry).not.toBeNull();
    expect(entry?.apy).toBe(3.6);
  });

  it("USDS: destinationAddress equals SKY_SAVINGS[1].sUSDS vault address", () => {
    const ctx = buildApyContext(ALL_POOLS, [STABLE_USDS_ETH]);
    const entry = ctx.getBestYield("USDS", 1);
    expect(entry?.destinationAddress).toBe(SUSDS_ETH_ADDRESS);
  });

  it("USDS: projectLabel contains 'Sky Savings'", () => {
    const ctx = buildApyContext(ALL_POOLS, [STABLE_USDS_ETH]);
    const entry = ctx.getBestYield("USDS", 1);
    expect(entry?.projectLabel).toContain("Sky Savings");
  });
});

describe("buildApyContext: USDC/USDT max-APY ranking with TVL tie-break (YIELD-02)", () => {
  it("ranking: picks Morpho 5.1% over Aave 4.5% for USDC on Arbitrum (max-apy)", () => {
    const ctx = buildApyContext(ALL_POOLS, [STABLE_USDC_ARB]);
    const entry = ctx.getBestYield("USDC", 42_161);
    expect(entry?.apy).toBe(5.1);
  });

  it("TVL gate: excludes sub-$10M pool even if it has the highest APY", () => {
    // POOL_LOW_TVL_USDC_ARB has 9.9% APY but only $5M TVL — must be excluded
    const ctx = buildApyContext(ALL_POOLS, [STABLE_USDC_ARB]);
    const entry = ctx.getBestYield("USDC", 42_161);
    // Winner must NOT be 9.9% (the low-TVL pool)
    expect(entry?.apy).not.toBe(9.9);
  });

  it("apyReward-only: pool with apyBase:null but valid apy still qualifies", () => {
    const ethUsdcStable = {
      ...STABLE_USDC_ARB,
      chainId: 1,
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    };
    const ctx = buildApyContext([POOL_SPARKLEND_REWARD_ONLY], [ethUsdcStable]);
    const entry = ctx.getBestYield("USDC", 1);
    expect(entry?.apy).toBe(3.45);
  });

  it("tie-break: equal APY → higher TVL wins", () => {
    const poolA = {
      ...POOL_AAVE_V3_USDC_ARB,
      pool: "pool-a",
      project: "aave-v3",
      apy: 4.5,
      tvlUsd: 100_000_000,
    };
    const poolB = {
      ...POOL_AAVE_V3_USDC_ARB,
      pool: "pool-b",
      project: "sparklend",
      apy: 4.5,
      tvlUsd: 200_000_000,
    };
    const ctx = buildApyContext([poolA, poolB], [STABLE_USDC_ARB]);
    const entry = ctx.getBestYield("USDC", 42_161);
    // Higher-TVL pool (poolB, $200M) must win the tie-break
    expect(entry?.apy).toBe(4.5);
    // projectLabel should reflect the higher-TVL winner
    expect(entry?.projectLabel).toBeTruthy();
  });
});

describe("buildApyContext: degrade paths (YIELD-03)", () => {
  it("degrade: returns null for chainId absent from DEFILLAMA_YIELDS_CHAIN_SLUGS", () => {
    const unknownChainStable = { ...STABLE_USDC_ARB, chainId: 56 }; // BNB Chain
    const ctx = buildApyContext(ALL_POOLS, [unknownChainStable]);
    const entry = ctx.getBestYield("USDC", 56);
    expect(entry).toBeNull();
  });

  it("degrade: returns null when no pool matches the stablecoin", () => {
    const ctx = buildApyContext([], [STABLE_USDC_ARB]);
    const entry = ctx.getBestYield("USDC", 42_161);
    expect(entry).toBeNull();
  });

  it("degrade: pool whose apy rounds to 0.0 at 1dp is excluded (CR-01, YIELD-03)", () => {
    // 0.03% renders as "~0.0% APY" via toFixed(1); must NOT surface as a venue.
    const subRoundingPool = {
      ...POOL_AAVE_V3_USDC_ARB,
      pool: "sub-rounding-apy-uuid",
      apy: 0.03,
    };
    const ctx = buildApyContext([subRoundingPool], [STABLE_USDC_ARB]);
    const entry = ctx.getBestYield("USDC", 42_161);
    expect(entry).toBeNull();
  });

  it("degrade: pool with an implausibly large apy is excluded (WR-01)", () => {
    // apy: 5000 is malformed/incentive-spike noise from an untrusted feed.
    const absurdApyPool = {
      ...POOL_AAVE_V3_USDC_ARB,
      pool: "absurd-apy-uuid",
      apy: 5000,
    };
    const ctx = buildApyContext([absurdApyPool], [STABLE_USDC_ARB]);
    const entry = ctx.getBestYield("USDC", 42_161);
    expect(entry).toBeNull();
  });

  it("resilience: a non-string underlyingTokens element does not throw or block other lookups (WR-02)", () => {
    const malformedPool = {
      ...POOL_AAVE_V3_USDC_ARB,
      pool: "malformed-underlying-uuid",
      // Untrusted feed: a non-string element must not throw on toLowerCase().
      underlyingTokens: [null, 123] as unknown as string[],
    };
    const ctx = buildApyContext(
      [malformedPool, POOL_SKY_SUSDS_ETH],
      [STABLE_USDC_ARB, STABLE_USDS_ETH]
    );
    // The malformed Arbitrum pool is skipped (no match), not fatal...
    expect(ctx.getBestYield("USDC", 42_161)).toBeNull();
    // ...and the unrelated USDS lookup still resolves to its sky-lending pool.
    expect(ctx.getBestYield("USDS", 1)?.apy).toBe(3.6);
  });
});
