/**
 * Route-mock ScanResponse fixture for the /scan E2E suite.
 *
 * This file defines plain object literals — no server-only imports.
 * lib/scan/types.ts has `import "server-only"` at line 1; all shapes
 * are mirrored locally here so the fixture is safe in any context.
 */

type StablecoinBalance = {
  chainId: number;
  symbol: string;
  tokenAddress: string;
  amount: string;
  decimals: number;
  usdValue: number | null;
  priceUsd: number | null;
  depegged: boolean;
};

type UnavailableChain = {
  chainId: number;
  reason: string;
};

type SuggestionCategory = "health" | "yield" | "alert" | "claim";

type SuggestionDescriptor = {
  id: string;
  name: string;
  description: string;
  category: SuggestionCategory;
  chainId: number;
  readOrWrite: "read" | "write";
  confirmInputs: Record<string, string>;
  riskNote: string;
  protocol?: string;
  usdValue: number | null;
};

type ScanFixture = {
  schemaVersion: number;
  address: string;
  positions: Record<string, unknown>[];
  stablecoins: StablecoinBalance[];
  unavailableChains: UnavailableChain[];
  scannedAt: string;
  suggestions: SuggestionDescriptor[];
};

/**
 * Full-featured fixture: two suggestions (health + yield), one depegged
 * stablecoin, and one unavailable chain. Used for SCANUI-02..05 assertions.
 *
 * Ethereum (chainId 1) is in unavailableChains to test the unavailable-badge
 * path. Both suggestions are on Ethereum so the fixture is self-consistent as
 * a route-mock (the engine would still return them from a prior scan or from
 * another chain's data; the E2E verifies the UI renders what the API returns).
 */
export const scanResponseFixture: ScanFixture = {
  schemaVersion: 1,
  address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  positions: [],
  stablecoins: [
    {
      chainId: 1,
      symbol: "USDC",
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: "1000000000",
      decimals: 6,
      usdValue: 0.94,
      priceUsd: 0.94,
      depegged: true,
    },
  ],
  unavailableChains: [
    {
      chainId: 1,
      reason: "timeout",
    },
  ],
  scannedAt: "2026-06-17T10:00:00.000Z",
  suggestions: [
    {
      id: "health-aave-v3-1",
      name: "Aave V3 Health Factor Alert",
      description:
        "Your Aave V3 health factor on Ethereum is 1.42, approaching the liquidation threshold.",
      category: "health",
      chainId: 1,
      readOrWrite: "read",
      confirmInputs: {
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        threshold: "1.3",
      },
      riskNote:
        "Monitor your position daily. Health factors below 1.0 trigger liquidation.",
      protocol: "aave-v3",
      usdValue: 12_500,
    },
    {
      id: "yield-lido-42161",
      name: "Lido stETH Yield Monitor",
      description:
        "You hold 2.5 stETH on Arbitrum earning approximately 4.2% APY via Lido.",
      category: "yield",
      chainId: 42_161,
      readOrWrite: "read",
      confirmInputs: {
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      },
      riskNote:
        "stETH yield fluctuates with Ethereum validator rewards and Lido protocol fees.",
      protocol: "lido",
      usdValue: 8750,
    },
  ],
};

/**
 * Empty-state fixture: no suggestions. Used to test the empty-state UI branch
 * where `data-testid="scan-results-empty"` is rendered.
 */
export const emptyScanResponseFixture: ScanFixture = {
  schemaVersion: 1,
  address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  positions: [],
  stablecoins: [],
  unavailableChains: [],
  scannedAt: "2026-06-17T10:00:00.000Z",
  suggestions: [],
};
