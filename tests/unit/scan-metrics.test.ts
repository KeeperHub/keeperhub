/**
 * Unit tests for scan observability metrics — HARDEN-03.
 *
 * Verifies: SCAN_CACHE_HIT_TOTAL is incremented on a fresh cached row, and
 * SCAN_CACHE_MISS_TOTAL is incremented when the cache is empty.
 *
 * Note: SCAN_ADDRESS_DURATION (recordLatency) is asserted in scan-route.test.ts
 * per the instrumentation split — duration wraps the `scanAddress` call in the
 * route, while cache hit/miss counters live inside the scanner itself.
 *
 * Wave 0: All tests are RED. The scanner has no metrics instrumentation yet;
 * these tests describe the FINAL behavior and turn GREEN in 55-03.
 *
 * Mocks: db.select/insert chains, getEnabledChains, scannableChainIds,
 *        scanChains, maybeZerionFallback; metrics collector is injected as a
 *        spy via setMetricsCollector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockDbSelect,
  mockDbSelectFrom,
  mockDbSelectFromWhere,
  mockDbSelectFromWhereLimit,
  mockDbInsert,
  mockDbInsertValues,
  mockDbInsertValuesConflict,
  mockGetEnabledChains,
  mockScannableChainIds,
  mockScanChains,
  mockMaybeZerionFallback,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbSelectFrom: vi.fn(),
  mockDbSelectFromWhere: vi.fn(),
  mockDbSelectFromWhereLimit: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbInsertValues: vi.fn(),
  mockDbInsertValuesConflict: vi.fn(),
  mockGetEnabledChains: vi.fn(),
  mockScannableChainIds: vi.fn(),
  mockScanChains: vi.fn(),
  mockMaybeZerionFallback: vi.fn(),
}));

// Override the global db mock from setup.ts with the full chain scanAddress needs
vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
}));

vi.mock("@/lib/rpc/chain-service", () => ({
  getEnabledChains: mockGetEnabledChains,
}));

vi.mock("@/lib/scan/adapters/protocol-registry", () => ({
  AAVE_V3_POOLS: {},
  LIDO_TOKENS: {},
  STABLECOIN_CHAINLINK_FEEDS: {},
  scannableChainIds: mockScannableChainIds,
}));

vi.mock("@/lib/scan/scan-chains", () => ({
  scanChains: mockScanChains,
}));

vi.mock("@/lib/scan/zerion-fallback", () => ({
  isZerionEnabled: vi.fn(() => false),
  maybeZerionFallback: mockMaybeZerionFallback,
}));

// Mock heavy RPC/adapter dependencies not relevant to metrics testing
vi.mock("@/lib/rpc/provider-factory", () => ({ getRpcProvider: vi.fn() }));
vi.mock("@/lib/scan/adapters/aave-v3", () => ({
  buildAaveV3Calls: vi.fn(),
  decodeAaveV3Results: vi.fn(),
}));
vi.mock("@/lib/scan/adapters/lido", () => ({
  buildLidoCalls: vi.fn(),
  decodeLidoResults: vi.fn(),
}));
vi.mock("@/lib/scan/adapters/stablecoins", () => ({
  buildStablecoinCalls: vi.fn(),
  decodeStablecoinResults: vi.fn(),
}));
vi.mock("@/lib/scan/multicall-batch", () => ({
  executeMulticallBatch: vi.fn(),
}));
vi.mock("@/lib/scan/price/chainlink", () => ({
  isDepegged: vi.fn(),
  readChainlinkPrice: vi.fn(),
}));
vi.mock("@/lib/scan/price/index", () => ({
  resolveUsdPrice: vi.fn(),
}));

import { resetMetricsCollector, setMetricsCollector } from "@/lib/metrics";
import { MetricNames, type MetricsCollector } from "@/lib/metrics/types";

const { scanAddress } = await import("@/lib/scan/scanner");

const VALID_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const CACHED_SCAN_RESULT = {
  schemaVersion: 1,
  address: VALID_ADDRESS,
  positions: [],
  stablecoins: [],
  unavailableChains: [],
  scannedAt: new Date().toISOString(),
};

function makeSpyCollector() {
  return {
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    recordWarning: vi.fn(),
    setGauge: vi.fn(),
  };
}

describe("scanAddress: cache observability metrics (HARDEN-03)", () => {
  let collector: ReturnType<typeof makeSpyCollector>;

  beforeEach(() => {
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectFromWhere.mockReset();
    mockDbSelectFromWhereLimit.mockReset();
    mockDbInsert.mockReset();
    mockDbInsertValues.mockReset();
    mockDbInsertValuesConflict.mockReset();
    mockGetEnabledChains.mockReset();
    mockScannableChainIds.mockReset();
    mockScanChains.mockReset();
    mockMaybeZerionFallback.mockReset();

    // Wire the fluent select chain: select().from().where().limit()
    mockDbSelect.mockReturnValue({ from: mockDbSelectFrom });
    mockDbSelectFrom.mockReturnValue({ where: mockDbSelectFromWhere });
    mockDbSelectFromWhere.mockReturnValue({
      limit: mockDbSelectFromWhereLimit,
    });

    // Wire the fluent insert chain: insert().values().onConflictDoUpdate()
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockReturnValue({
      onConflictDoUpdate: mockDbInsertValuesConflict,
    });
    mockDbInsertValuesConflict.mockResolvedValue({});

    // Cache miss defaults — override per test
    mockDbSelectFromWhereLimit.mockResolvedValue([]);
    mockGetEnabledChains.mockResolvedValue([]);
    mockScannableChainIds.mockReturnValue([]);
    mockScanChains.mockResolvedValue({
      chainOutputs: [],
      unavailableChains: [],
    });
    mockMaybeZerionFallback.mockResolvedValue([]);

    collector = makeSpyCollector();
    setMetricsCollector(collector as MetricsCollector);
  });

  afterEach(() => {
    resetMetricsCollector();
  });

  it("records SCAN_CACHE_HIT_TOTAL and skips RPC on a fresh cached row", async () => {
    mockDbSelectFromWhereLimit.mockResolvedValue([
      { resultJson: CACHED_SCAN_RESULT },
    ]);

    await scanAddress(VALID_ADDRESS);

    expect(collector.incrementCounter).toHaveBeenCalledWith(
      MetricNames.SCAN_CACHE_HIT_TOTAL
    );
    // Ensure RPC fan-out was NOT triggered (cache short-circuit)
    expect(mockScanChains).not.toHaveBeenCalled();
  });

  it("records SCAN_CACHE_MISS_TOTAL on empty cache", async () => {
    // Empty cache — the miss path runs through scan + insert
    mockDbSelectFromWhereLimit.mockResolvedValue([]);

    await scanAddress(VALID_ADDRESS);

    expect(collector.incrementCounter).toHaveBeenCalledWith(
      MetricNames.SCAN_CACHE_MISS_TOTAL
    );
  });
});
