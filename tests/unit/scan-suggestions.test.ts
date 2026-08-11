/**
 * Tests for the scan suggestion engine (52-02).
 *
 * Requirements covered: SUGGEST-01..10
 */
import { describe, expect, it } from "vitest";
import type { ApyContext } from "@/lib/scan/suggestions/engine";
import { buildSuggestions } from "@/lib/scan/suggestions/engine";
import {
  clampHfThreshold,
  DUST_THRESHOLD_USD,
  hfThresholdRaw,
  MAX_SUGGESTIONS,
} from "@/lib/scan/suggestions/ranking";
import type {
  SuggestionCategory,
  SuggestionDescriptor,
} from "@/lib/scan/suggestions/types";
import { SUGGESTION_DISCLAIMER } from "@/lib/scan/suggestions/types";

// ---------------------------------------------------------------------------
// Top-level regex constants (useTopLevelRegex rule)
// ---------------------------------------------------------------------------

const RE_HF_VALUE = /1\.8/;
const RE_HF_BELOW_FLOOR = /1\.[012]\d/;
const RE_NOT_FINANCIAL_ADVICE = /not financial advice/i;
// APY-aware copy pattern: e.g. "3.6% APY via Sky Savings (sUSDS)"
const RE_APY_AWARE = /\d+\.\d+% APY via/;
// Generic fallback copy (no APY figure present)
const RE_IDLE_YIELD = /for idle yield opportunities\./;

// Spark/Sky routing tests (SCAN-03 + SCAN-04)
const SUDS_TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const BASE_SCAN = {
  schemaVersion: 1,
  address: VITALIK,
  positions: [],
  stablecoins: [],
  unavailableChains: [],
  scannedAt: new Date().toISOString(),
};

const AAVE_POSITION = {
  chainId: 42_161,
  protocol: "aave-v3" as const,
  healthFactor: 1.8,
  noActiveLoan: false,
  totalCollateralUsd: 10_000,
  totalDebtUsd: 5000,
  suppliedAssets: [
    {
      symbol: "WETH",
      tokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      amount: "3000000000000000000",
      decimals: 18,
      usdValue: 10_000,
    },
  ],
  borrowedAssets: [
    {
      symbol: "USDC",
      tokenAddress: ARBITRUM_USDC,
      amount: "5000000000",
      decimals: 6,
      usdValue: 5000,
    },
  ],
};

const LIDO_POSITION = {
  chainId: 1,
  protocol: "lido" as const,
  healthFactor: null,
  noActiveLoan: true,
  totalCollateralUsd: 1000,
  totalDebtUsd: null,
  suppliedAssets: [
    {
      symbol: "stETH",
      tokenAddress: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
      amount: "500000000000000000",
      decimals: 18,
      usdValue: 1200,
    },
  ],
  borrowedAssets: [],
};

const USDC_STABLE = {
  chainId: 42_161,
  symbol: "USDC",
  tokenAddress: ARBITRUM_USDC,
  amount: "500000000",
  decimals: 6,
  usdValue: 500,
  priceUsd: 1.0,
  depegged: false,
};

const DEPEGGED_STABLE = {
  ...USDC_STABLE,
  symbol: "USDC-depegged",
  priceUsd: 0.93,
  depegged: true,
};

const DUST_STABLE = {
  ...USDC_STABLE,
  usdValue: DUST_THRESHOLD_USD / 2,
};

// ---------------------------------------------------------------------------
// SUGGEST-01: Engine function exists and returns SuggestionDescriptor[]
// ---------------------------------------------------------------------------

describe("SUGGEST-01: engine returns SuggestionDescriptor[]", () => {
  it("buildSuggestions is a function", () => {
    expect(typeof buildSuggestions).toBe("function");
  });

  it("returns an array when given a minimal scan with no positions", () => {
    const result = buildSuggestions(BASE_SCAN);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-02 + 06 + 09: Health factor monitoring suggestions
// ---------------------------------------------------------------------------

describe("SUGGEST-02/06/09: health suggestion from lending position", () => {
  it("health: Aave V3 position with active loan produces a health suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [AAVE_POSITION],
    });
    const health = result.filter(
      (s: SuggestionDescriptor) => s.category === "health"
    );
    expect(health.length).toBeGreaterThan(0);
  });

  it("health: suggestion references actual HF value in description (SUGGEST-06)", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [AAVE_POSITION],
    });
    const health = result.find(
      (s: SuggestionDescriptor) => s.category === "health"
    );
    expect(health?.description).toMatch(RE_HF_VALUE);
  });

  it("health: HF threshold never falls below 1.3 floor (SUGGEST-09)", () => {
    const lowHfPosition = { ...AAVE_POSITION, healthFactor: 1.25 };
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [lowHfPosition],
    });
    const health = result.find(
      (s: SuggestionDescriptor) => s.category === "health"
    );
    // description or confirmInputs threshold should never go below 1.3
    const threshold = health?.confirmInputs?.threshold ?? "";
    expect(String(threshold)).not.toMatch(RE_HF_BELOW_FLOOR);
  });

  it("health: position with no active loan (healthFactor null) produces no health suggestion", () => {
    const noLoan = { ...AAVE_POSITION, healthFactor: null, noActiveLoan: true };
    const result = buildSuggestions({ ...BASE_SCAN, positions: [noLoan] });
    const health = result.filter(
      (s: SuggestionDescriptor) => s.category === "health"
    );
    expect(health.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-03: Stablecoin yield monitoring + depeg suppression
// ---------------------------------------------------------------------------

describe("SUGGEST-03: yield suggestion with depeg suppression", () => {
  it("yield: non-depegged stablecoin above dust threshold produces a yield suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [USDC_STABLE],
    });
    const yields = result.filter(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yields.length).toBeGreaterThan(0);
  });

  it("depeg: depegged stablecoin produces NO yield suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [DEPEGGED_STABLE],
    });
    const yields = result.filter(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yields.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-04: Price/balance threshold-alert suggestions
// ---------------------------------------------------------------------------

describe("SUGGEST-04: alert suggestion", () => {
  it("alert: category appears in SuggestionCategory union type", () => {
    const cat: SuggestionCategory = "alert";
    expect(cat).toBe("alert");
  });

  it("alert: alert-category suggestions carry chainId", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [USDC_STABLE],
    });
    for (const s of result) {
      expect(typeof s.chainId).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-05: Reward-claim / staking reminder suggestions
// ---------------------------------------------------------------------------

describe("SUGGEST-05: claim suggestion", () => {
  it("claim: category appears in SuggestionCategory union type", () => {
    const cat: SuggestionCategory = "claim";
    expect(cat).toBe("claim");
  });

  it("claim: Lido position produces a claim/staking-reminder suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [LIDO_POSITION],
    });
    const claim = result.filter(
      (s: SuggestionDescriptor) =>
        s.category === "claim" || s.protocol === "lido"
    );
    expect(claim.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-07: Dust filter (DUST_THRESHOLD_USD min) and cap (MAX_SUGGESTIONS, ranked)
// ---------------------------------------------------------------------------

describe("SUGGEST-07: dust filter and cap/rank", () => {
  it("dust: stablecoin below the dust threshold produces no suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [DUST_STABLE],
    });
    expect(result.length).toBe(0);
  });

  it("cap: output never exceeds MAX_SUGGESTIONS regardless of input count", () => {
    const manyStables = Array.from({ length: 10 }, (_, i) => ({
      ...USDC_STABLE,
      tokenAddress: `0x${String(i).padStart(40, "0")}`,
      chainId: 42_161 + i,
    }));
    const result = buildSuggestions({ ...BASE_SCAN, stablecoins: manyStables });
    expect(result.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });

  it("cap: health suggestions rank before yield suggestions", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [AAVE_POSITION],
      stablecoins: [USDC_STABLE],
    });
    const categories = result.map((s: SuggestionDescriptor) => s.category);
    const healthIdx = categories.indexOf("health");
    const yieldIdx = categories.indexOf("yield");
    if (healthIdx !== -1 && yieldIdx !== -1) {
      expect(healthIdx).toBeLessThan(yieldIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-08: Every suggestion carries required chainId
// ---------------------------------------------------------------------------

describe("SUGGEST-08: chainId is required on every descriptor", () => {
  it("all emitted suggestions carry a numeric chainId", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [AAVE_POSITION],
      stablecoins: [USDC_STABLE],
    });
    for (const s of result) {
      expect(typeof s.chainId).toBe("number");
    }
  });

  it("yield suggestion chainId matches the stablecoin chainId", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [USDC_STABLE],
    });
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.chainId).toBe(42_161);
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-10: read/write label, per-card risk note, global disclaimer
// ---------------------------------------------------------------------------

describe("SUGGEST-10: disclaimer and risk notes", () => {
  it("disclaimer: SUGGESTION_DISCLAIMER is a non-empty string", () => {
    expect(typeof SUGGESTION_DISCLAIMER).toBe("string");
    expect(SUGGESTION_DISCLAIMER.length).toBeGreaterThan(0);
  });

  it("disclaimer: SUGGESTION_DISCLAIMER contains 'not financial advice'", () => {
    expect(SUGGESTION_DISCLAIMER).toMatch(RE_NOT_FINANCIAL_ADVICE);
  });

  it("disclaimer: every suggestion has a non-empty riskNote", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [AAVE_POSITION],
      stablecoins: [USDC_STABLE],
    });
    for (const s of result) {
      expect(typeof s.riskNote).toBe("string");
      expect(s.riskNote.length).toBeGreaterThan(0);
    }
  });

  it("disclaimer: every suggestion has readOrWrite set to 'read' or 'write'", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [USDC_STABLE],
    });
    for (const s of result) {
      expect(["read", "write"]).toContain(s.readOrWrite);
    }
  });
});

// ---------------------------------------------------------------------------
// Spark + Sky fixtures (SCAN-03 + SCAN-04)
// ---------------------------------------------------------------------------

const SPARK_POSITION_ACTIVE = {
  chainId: 1,
  protocol: "spark" as const,
  healthFactor: 1.65,
  noActiveLoan: false,
  totalCollateralUsd: 8000,
  totalDebtUsd: 4000,
  suppliedAssets: [
    {
      symbol: "WETH",
      tokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      amount: "3000000000000000000",
      decimals: 18,
      usdValue: 8000,
    },
  ],
  borrowedAssets: [
    {
      symbol: "USDC",
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: "4000000000",
      decimals: 6,
      usdValue: 4000,
    },
  ],
};

const SPARK_POSITION_SUPPLY_ONLY = {
  chainId: 1,
  protocol: "spark" as const,
  healthFactor: null,
  noActiveLoan: true,
  totalCollateralUsd: 2000,
  totalDebtUsd: null,
  suppliedAssets: [
    {
      symbol: "WETH",
      tokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      amount: "1000000000000000000",
      decimals: 18,
      usdValue: 2000,
    },
  ],
  borrowedAssets: [],
};

const SKY_POSITION = {
  chainId: 1,
  protocol: "sky" as const,
  healthFactor: null,
  noActiveLoan: true,
  totalCollateralUsd: 500,
  totalDebtUsd: null,
  suppliedAssets: [
    {
      symbol: "sUSDS",
      tokenAddress: SUDS_TOKEN_ADDRESS,
      amount: "450000000000000000000",
      decimals: 18,
      usdValue: 500,
    },
  ],
  borrowedAssets: [],
};

// ---------------------------------------------------------------------------
// SCAN-03: Spark routing
// ---------------------------------------------------------------------------

describe("SCAN-03: Spark suggestion routing", () => {
  it("spark active loan: produces a health suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SPARK_POSITION_ACTIVE],
    });
    const health = result.filter(
      (s: SuggestionDescriptor) => s.category === "health"
    );
    expect(health.length).toBeGreaterThan(0);
  });

  it("spark active loan: health description references 'Spark'", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SPARK_POSITION_ACTIVE],
    });
    const health = result.find(
      (s: SuggestionDescriptor) => s.category === "health"
    );
    expect(health?.description).toContain("Spark");
  });

  it("spark supply-only: produces an alert suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SPARK_POSITION_SUPPLY_ONLY],
    });
    const alert = result.filter(
      (s: SuggestionDescriptor) => s.category === "alert"
    );
    expect(alert.length).toBeGreaterThan(0);
  });

  it("spark supply-only: does NOT produce a claim suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SPARK_POSITION_SUPPLY_ONLY],
    });
    const claim = result.filter(
      (s: SuggestionDescriptor) => s.category === "claim"
    );
    expect(claim.length).toBe(0);
  });

  it("spark supply-only: alert description references 'Spark'", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SPARK_POSITION_SUPPLY_ONLY],
    });
    const alert = result.find(
      (s: SuggestionDescriptor) => s.category === "alert"
    );
    expect(alert?.description).toContain("Spark");
  });
});

// ---------------------------------------------------------------------------
// SCAN-04: Sky routing
// ---------------------------------------------------------------------------

describe("SCAN-04: Sky suggestion routing", () => {
  it("sky null-HF: produces a claim suggestion (NOT alert)", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SKY_POSITION],
    });
    const claim = result.filter(
      (s: SuggestionDescriptor) => s.category === "claim"
    );
    expect(claim.length).toBeGreaterThan(0);
  });

  it("sky null-HF: does NOT produce a supply-only price alert suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SKY_POSITION],
    });
    // The sky position must route to claim, never to the supply-only
    // price-alert builder. Other alert families (gas-balance) may appear
    // for the position's chain and are not part of this routing contract.
    const priceAlerts = result.filter((s: SuggestionDescriptor) =>
      s.id.startsWith("price-alert-")
    );
    expect(priceAlerts.length).toBe(0);
  });

  it("sky claim: card name is savings copy ('Sky Savings Balance Monitor')", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SKY_POSITION],
    });
    const claim = result.find(
      (s: SuggestionDescriptor) => s.category === "claim"
    );
    expect(claim?.name).toBe("Sky Savings Balance Monitor");
  });

  it("sky claim: description references 'Sky'", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SKY_POSITION],
    });
    const claim = result.find(
      (s: SuggestionDescriptor) => s.category === "claim"
    );
    expect(claim?.description).toContain("Sky");
  });

  it("sky claim: confirmInputs.stakingTokenAddress equals the sUSDS token address from the position", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      positions: [SKY_POSITION],
    });
    const claim = result.find(
      (s: SuggestionDescriptor) => s.category === "claim"
    );
    expect(claim?.confirmInputs?.stakingTokenAddress).toBe(SUDS_TOKEN_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// SUGGEST-09: HF clamping and 1e18-scale threshold helpers (ranking.ts)
// ---------------------------------------------------------------------------

describe("SUGGEST-09: clampHfThreshold and hfThresholdRaw helpers", () => {
  it("clamp: returns HF_DEFAULT (1.5) when currentHf > 1.5", () => {
    expect(clampHfThreshold(2.5)).toBe(1.5);
    expect(clampHfThreshold(1.6)).toBe(1.5);
    expect(clampHfThreshold(10)).toBe(1.5);
  });

  it("clamp: returns value >= 1.3 and < 1.5 when currentHf is between floor and default", () => {
    const result = clampHfThreshold(1.4);
    expect(result).toBeGreaterThanOrEqual(1.3);
    expect(result).toBeLessThan(1.5);
  });

  it("clamp: returns hard floor 1.3 when currentHf at or below 1.3 + 0.1 margin", () => {
    expect(clampHfThreshold(1.25)).toBe(1.3);
    expect(clampHfThreshold(1.0)).toBe(1.3);
    expect(clampHfThreshold(0.5)).toBe(1.3);
  });

  it("clamp: never returns a value below 1.3 for any finite input", () => {
    const inputs = [0, 0.5, 1.0, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 2.0, 5.0];
    for (const hf of inputs) {
      expect(clampHfThreshold(hf)).toBeGreaterThanOrEqual(1.3);
    }
  });

  it("hfThresholdRaw: 1.5 → '1500000000000000000'", () => {
    expect(hfThresholdRaw(1.5)).toBe("1500000000000000000");
  });

  it("hfThresholdRaw: 1.3 → '1300000000000000000'", () => {
    expect(hfThresholdRaw(1.3)).toBe("1300000000000000000");
  });
});

// ---------------------------------------------------------------------------
// YIELD: APY-aware yield suggestions (57-01 RED wave — YIELD-01..04)
// ---------------------------------------------------------------------------

// Aave V3 Pool proxy on Arbitrum from AAVE_V3_POOLS registry
const AAVE_V3_ARB_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
// sUSDS vault on Ethereum from SKY_SAVINGS[1].sUSDS registry
const SUSDS_ETH_VAULT = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

const USDS_ETH_STABLE = {
  chainId: 1,
  symbol: "USDS",
  tokenAddress: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  amount: "500000000000000000000",
  decimals: 18,
  usdValue: 500,
  priceUsd: 1.0,
  depegged: false,
};

/**
 * Builds a minimal ApyContext from an overrides map.
 *
 * `getBestYield` looks up `${symbol}:${chainId}` in the overrides map and
 * returns the entry (or null). Matches the shape returned by buildApyContext
 * in the real implementation (57-02).
 */
function makeApyContext(
  overrides?: Record<
    string,
    {
      apy: number;
      projectLabel: string;
      destinationAddress: string | null;
    } | null
  >
): ApyContext {
  return {
    getBestYield: (symbol: string, chainId: number) => {
      const key = `${symbol}:${chainId}`;
      return overrides?.[key] ?? null;
    },
  };
}

describe("YIELD: APY-aware yield suggestions (57-01 RED wave)", () => {
  // (a) USDS + apyContext Sky → APY-aware copy + destinationAddress (YIELD-01)
  // RED: engine still emits generic copy; Wave 2 (57-02) turns this GREEN.
  it("(a) USDS + Sky apyContext: description contains APY rate and venue (YIELD-01)", () => {
    const apyCtx = makeApyContext({
      "USDS:1": {
        apy: 3.6,
        projectLabel: "Sky Savings (sUSDS)",
        destinationAddress: SUSDS_ETH_VAULT,
      },
    });
    const result = buildSuggestions(
      { ...BASE_SCAN, stablecoins: [USDS_ETH_STABLE] },
      apyCtx
    );
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.description).toMatch(RE_APY_AWARE);
    expect(yield_?.description).toContain("3.6% APY via Sky Savings (sUSDS)");
  });

  // (a) continued: confirmInputs.destinationAddress is the sUSDS vault address
  it("(a) USDS + Sky apyContext: confirmInputs.destinationAddress is sUSDS vault", () => {
    const apyCtx = makeApyContext({
      "USDS:1": {
        apy: 3.6,
        projectLabel: "Sky Savings (sUSDS)",
        destinationAddress: SUSDS_ETH_VAULT,
      },
    });
    const result = buildSuggestions(
      { ...BASE_SCAN, stablecoins: [USDS_ETH_STABLE] },
      apyCtx
    );
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.confirmInputs?.destinationAddress).toBe(SUSDS_ETH_VAULT);
  });

  // (b) USDC + Aave V3 apyContext → APY-aware copy (YIELD-02)
  // RED: engine still emits generic copy; Wave 2 turns this GREEN.
  it("(b) USDC + Aave apyContext: description contains APY rate and venue (YIELD-02)", () => {
    const apyCtx = makeApyContext({
      "USDC:42161": {
        apy: 4.2,
        projectLabel: "Aave V3 on Arbitrum",
        destinationAddress: AAVE_V3_ARB_POOL,
      },
    });
    const result = buildSuggestions(
      { ...BASE_SCAN, stablecoins: [USDC_STABLE] },
      apyCtx
    );
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.description).toContain("4.2% APY via Aave V3 on Arbitrum");
  });

  // (c) apyContext returns null → degrade to generic copy (YIELD-03)
  // GREEN: engine already outputs generic copy; remains a regression guard.
  it("(c) apyContext returns null → degrades to generic copy (YIELD-03)", () => {
    const apyCtx = makeApyContext({ "USDC:42161": null });
    const result = buildSuggestions(
      { ...BASE_SCAN, stablecoins: [USDC_STABLE] },
      apyCtx
    );
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.description).toMatch(RE_IDLE_YIELD);
    expect(yield_?.description).not.toMatch(RE_APY_AWARE);
    expect(yield_?.confirmInputs).not.toHaveProperty("destinationAddress");
  });

  // (d) apyContext entry with apy:0 → degrade to generic copy (YIELD-03)
  // GREEN: engine uses generic copy; remains a regression guard.
  it("(d) apyContext entry with apy:0 → degrades to generic copy (YIELD-03)", () => {
    const apyCtx = makeApyContext({
      "USDC:42161": {
        apy: 0,
        projectLabel: "Aave V3 on Arbitrum",
        destinationAddress: AAVE_V3_ARB_POOL,
      },
    });
    const result = buildSuggestions(
      { ...BASE_SCAN, stablecoins: [USDC_STABLE] },
      apyCtx
    );
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.description).toMatch(RE_IDLE_YIELD);
    expect(yield_?.description).not.toMatch(RE_APY_AWARE);
  });

  // (e) APY-aware suggestion has readOrWrite === "read" (YIELD-04 invariant)
  // RED: compound test — APY-copy assertion fails first; readOrWrite guard
  // ensures the write invariant is preserved in Wave 2.
  it("(e) APY-aware yield suggestion has readOrWrite 'read' (YIELD-04)", () => {
    const apyCtx = makeApyContext({
      "USDC:42161": {
        apy: 4.2,
        projectLabel: "Aave V3 on Arbitrum",
        destinationAddress: AAVE_V3_ARB_POOL,
      },
    });
    const result = buildSuggestions(
      { ...BASE_SCAN, stablecoins: [USDC_STABLE] },
      apyCtx
    );
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    // Must be APY-aware copy (fails against stub — RED until 57-02)
    expect(yield_?.description).toMatch(RE_APY_AWARE);
    // Must remain read-only regardless of destination context (YIELD-04 guard)
    expect(yield_?.readOrWrite).toBe("read");
  });

  // (f) no apyContext arg → backward compat: generic copy unchanged
  // GREEN: existing behaviour; must never regress.
  it("(f) buildSuggestions without apyContext produces generic yield suggestion", () => {
    const result = buildSuggestions({
      ...BASE_SCAN,
      stablecoins: [USDC_STABLE],
    });
    const yield_ = result.find(
      (s: SuggestionDescriptor) => s.category === "yield"
    );
    expect(yield_?.description).toMatch(RE_IDLE_YIELD);
    expect(yield_?.description).not.toMatch(RE_APY_AWARE);
  });
});
