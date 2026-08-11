/**
 * Tests for the scan orchestrator (scanner.ts) — cache short-circuit and
 * cache-miss assembly.
 *
 * TDD: tests written first (RED), implementation added after (GREEN).
 *
 * Tests:
 *   A — cache-hit: returns cached ScanResponse and makes zero RPC calls
 *   B — cache-miss: assembles ScanResponse with schemaVersion:1, checksummed
 *       address, detected positions[], and writes a cache row with a future
 *       expiresAt (~5-min TTL)
 *   C — positive Spark+Sky: Spark active loan + sUSDS holding produce a
 *       spark position and a priced sky position (usdValue non-null)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── Mock function handles (declared before vi.mock so factories close over them) ─

const mockAggregate3StaticCall = vi.fn();
const mockDbSelectFn = vi.fn();
const mockDbInsertFn = vi.fn();
const mockGetRpcProvider = vi.fn();
const mockGetEnabledChains = vi.fn();
const mockFetchDefillamaPrice = vi.fn().mockResolvedValue(null);

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelectFn,
    insert: mockDbInsertFn,
  },
}));

vi.mock("@/lib/rpc/chain-service", () => ({
  getEnabledChains: mockGetEnabledChains,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

vi.mock("@/lib/scan/zerion-fallback", () => ({
  maybeZerionFallback: vi.fn().mockResolvedValue([]),
  isZerionEnabled: vi.fn().mockReturnValue(false),
}));

// Configurable DefiLlama mock — default null (no price). Override per-test
// with mockFetchDefillamaPrice.mockResolvedValueOnce(price) for Sky pricing.
vi.mock("@/lib/scan/price/defillama", () => ({
  fetchDefillamaPrice: mockFetchDefillamaPrice,
}));

// Mock ethers.Contract only — all other ethers methods (Interface, AbiCoder,
// getAddress, isAddress) remain real so test helpers can encode/decode data.
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        aggregate3 = { staticCall: mockAggregate3StaticCall };
      },
    },
  };
});

// ─── Imports (after vi.mock so hoisting is complete) ─────────────────────────

import { ethers } from "ethers";
import { SCAN_SCHEMA_VERSION, type ScanResponse } from "@/lib/scan/types";

// ─── Shared test data ─────────────────────────────────────────────────────────

// A valid, already-checksummed Ethereum address used across all tests.
const TEST_RAW = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TEST_LC = TEST_RAW.toLowerCase();
const TEST_CHECKSUMMED = ethers.getAddress(TEST_RAW);

const CACHED_RESPONSE: ScanResponse = {
  schemaVersion: SCAN_SCHEMA_VERSION,
  address: TEST_CHECKSUMMED,
  positions: [],
  stablecoins: [],
  unavailableChains: [],
  scannedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
};

// ─── Aave V3 encoding helpers ─────────────────────────────────────────────────

// Minimal Aave V3 Pool ABI for getUserAccountData + getUserEMode encoding.
// Mirrors lib/scan/adapters/aave-v3.ts without importing mocked modules.
const POOL_ABI_FRAGMENT = [
  {
    name: "getUserAccountData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    name: "getUserEMode",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const MAX_UINT256 = BigInt(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

// Lazy-init the pool interface so vi.mock("ethers") hoisting has already run.
let poolIface: ethers.Interface | null = null;
function getPoolIface(): ethers.Interface {
  if (!poolIface) {
    poolIface = new ethers.Interface(
      POOL_ABI_FRAGMENT as unknown as ethers.InterfaceAbi
    );
  }
  return poolIface;
}

/**
 * ABI-encode a getUserAccountData result tuple.
 * Supply-only user: totalCollateralBase > 0, totalDebtBase = 0,
 * healthFactor = MAX_UINT256.
 */
function encodeSupplyOnlyAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(100_000_000), // totalCollateralBase: $1.00 in 8-decimal USD base units
    BigInt(0), // totalDebtBase: no debt
    BigInt(0), // availableBorrowsBase
    BigInt(8000), // currentLiquidationThreshold
    BigInt(7500), // ltv
    MAX_UINT256, // healthFactor: sentinel for no-debt
  ]);
}

/**
 * ABI-encode a getUserAccountData result with zero collateral and zero debt.
 * Used for Spark (and Aave) no-position case: both totals zero causes the
 * adapter to return [] (user has never interacted with the pool).
 */
function encodeNoPositionAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(0), // totalCollateralBase: 0 (no position)
    BigInt(0), // totalDebtBase: 0 (no position)
    BigInt(0), // availableBorrowsBase
    BigInt(0), // currentLiquidationThreshold
    BigInt(0), // ltv
    BigInt(0), // healthFactor
  ]);
}

/**
 * ABI-encode a getUserAccountData result for an active Spark loan.
 * totalCollateralBase > 0, totalDebtBase > 0, healthFactor = 1.8 WAD.
 */
function encodeActiveLoanAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(1_000_000_000), // totalCollateralBase: $10 in 8-decimal USD
    BigInt(500_000_000), // totalDebtBase: $5 in 8-decimal USD
    BigInt(0), // availableBorrowsBase
    BigInt(8000), // currentLiquidationThreshold
    BigInt(7500), // ltv
    BigInt("1800000000000000000"), // healthFactor: 1.8 WAD
  ]);
}

/** ABI-encode a getUserEMode result (eMode category = 0 → no eMode). */
function encodeEMode(): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(0)]);
}

/** ABI-encode a uint256 value — used for ERC20 balanceOf and maxWithdraw. */
function encodeUint256(n: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("scan orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default db.insert mock — overridden per-test as needed.
    const mockValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    mockDbInsertFn.mockReturnValue({ values: mockValues });

    // Default RPC provider — overridden per-test as needed.
    mockGetRpcProvider.mockResolvedValue({
      executeWithFailover: vi
        .fn()
        .mockImplementation((fn: (p: unknown) => unknown) => fn({})),
    });

    // Default DefiLlama: no price (null) unless overridden per-test.
    mockFetchDefillamaPrice.mockResolvedValue(null);
  });

  // ─── Test A: cache-hit ─────────────────────────────────────────────────────

  describe("cache-hit", () => {
    it("returns the cached ScanResponse and issues zero getRpcProvider calls on a fresh row", async () => {
      // Cache check → fresh row present (expiresAt 4 min from now).
      mockDbSelectFn.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "row-1",
                address: TEST_LC,
                resultJson: CACHED_RESPONSE,
                scannedAt: new Date(Date.now() - 60_000),
                expiresAt: new Date(Date.now() + 4 * 60 * 1000),
              },
            ]),
          }),
        }),
      });

      // Dynamically import scanAddress to avoid circular mock issues.
      const { scanAddress } = await import("@/lib/scan/scanner");
      const result = await scanAddress(TEST_RAW);

      expect(result).toEqual(CACHED_RESPONSE);
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
    });
  });

  // ─── Test B: cache-miss assembles ─────────────────────────────────────────

  describe("cache-miss assembles", () => {
    /**
     * Shared mock DB setup for cache-miss tests:
     *   1st select: cache check → miss (empty array)
     *   2nd select: stablecoin query → empty (no stablecoins simplifies pricing)
     */
    function setupCacheMissDb(): void {
      let selectIdx = 0;
      mockDbSelectFn.mockImplementation(() => {
        selectIdx += 1;
        if (selectIdx === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });
    }

    it("returns schemaVersion:1, checksummed address, Aave position, and writes cache row with future expiresAt", async () => {
      setupCacheMissDb();

      // Chains: Ethereum only (chainId 1 is in AAVE_V3_POOLS, LIDO_TOKENS,
      // SPARK_POOLS, and SKY_SAVINGS).
      mockGetEnabledChains.mockResolvedValue([
        { id: "eth-1", chainId: 1, name: "Ethereum", isEnabled: true },
      ]);

      // aggregate3 returns 8 results for chain 1 in the new batch order:
      //   [aave, lido, spark, sky, stablecoin, chainlink]
      //   [0] Aave getUserAccountData  (supply-only user)
      //   [1] Aave getUserEMode        (eMode = 0)
      //   [2] Lido stETH balanceOf     (0 — no position)
      //   [3] Lido wstETH balanceOf    (0 — no position)
      //   [4] Spark getUserAccountData (no position: both totals zero)
      //   [5] Spark getUserEMode       (eMode = 0)
      //   [6] Sky sUSDS balanceOf      (0 — no position)
      //   [7] Sky sUSDS maxWithdraw    (0 — irrelevant when balanceOf = 0)
      mockAggregate3StaticCall.mockResolvedValue([
        [true, encodeSupplyOnlyAccountData()],
        [true, encodeEMode()],
        [true, encodeUint256(BigInt(0))], // stETH
        [true, encodeUint256(BigInt(0))], // wstETH
        [true, encodeNoPositionAccountData()], // Spark: no position
        [true, encodeEMode()], // Spark eMode
        [true, encodeUint256(BigInt(0))], // Sky balanceOf: 0
        [true, encodeUint256(BigInt(0))], // Sky maxWithdraw: 0
      ]);

      // Cache write spy.
      const mockInsertValues = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      });
      mockDbInsertFn.mockReturnValue({ values: mockInsertValues });

      const { scanAddress } = await import("@/lib/scan/scanner");
      const result = await scanAddress(TEST_RAW);

      // Schema shape
      expect(result.schemaVersion).toBe(SCAN_SCHEMA_VERSION);
      expect(result.address).toBe(TEST_CHECKSUMMED);
      expect(typeof result.scannedAt).toBe("string");

      // Aave V3 supply-only position detected
      expect(result.positions).toHaveLength(1);
      const position = result.positions[0];
      expect(position?.protocol).toBe("aave-v3");
      expect(position?.chainId).toBe(1);
      expect(position?.healthFactor).toBeNull(); // no debt → null
      expect(position?.noActiveLoan).toBe(true);

      // No Lido position (both balances are 0)
      expect(
        result.positions.filter(
          (p: { protocol: string }) => p.protocol === "lido"
        )
      ).toHaveLength(0);

      // No Spark position (both totals zero → no position)
      expect(
        result.positions.filter(
          (p: { protocol: string }) => p.protocol === "spark"
        )
      ).toHaveLength(0);

      // No Sky position (balanceOf = 0)
      expect(
        result.positions.filter(
          (p: { protocol: string }) => p.protocol === "sky"
        )
      ).toHaveLength(0);

      // No stablecoins (empty token registry for chain 1 in this test)
      expect(result.stablecoins).toHaveLength(0);

      // Cache write asserted
      expect(mockDbInsertFn).toHaveBeenCalledOnce();
      const writeRow = mockInsertValues.mock.calls[0]?.[0] as {
        address: string;
        expiresAt: Date;
        resultJson: ScanResponse;
      };
      expect(writeRow.address).toBe(TEST_LC);
      expect(writeRow.expiresAt).toBeInstanceOf(Date);
      // expiresAt must be > 4 min from now (validating ~5-min TTL)
      expect(writeRow.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 4 * 60 * 1000
      );
      expect(writeRow.resultJson.schemaVersion).toBe(SCAN_SCHEMA_VERSION);
    });

    it("positive: Spark active loan + sUSDS holding produce a spark position and a priced sky position", async () => {
      setupCacheMissDb();

      mockGetEnabledChains.mockResolvedValue([
        { id: "eth-1", chainId: 1, name: "Ethereum", isEnabled: true },
      ]);

      // Sky position amounts (18-decimal):
      //   sharesBalance: 1000 sUSDS shares held
      //   maxWithdraw:   500 USDS underlying redeemable
      const skyShares = BigInt("1000000000000000000000"); // 1000 sUSDS
      const skyMaxWithdraw = BigInt("500000000000000000000"); // 500 USDS

      // DefiLlama returns a live USDS price for the Sky pricing call.
      // USDS has no Chainlink feed so resolveUsdPrice falls through to DefiLlama.
      const usdsPrice = 0.9997;
      mockFetchDefillamaPrice.mockResolvedValueOnce(usdsPrice);

      // 8-slot batch: [aave x2, lido x2, spark x2, sky x2] (no stablecoins).
      //   [0] Aave getUserAccountData  (no position: both totals zero)
      //   [1] Aave getUserEMode        (eMode = 0)
      //   [2] Lido stETH balanceOf     (0 — no Lido position)
      //   [3] Lido wstETH balanceOf    (0 — no Lido position)
      //   [4] Spark getUserAccountData (active loan: HF = 1.8)
      //   [5] Spark getUserEMode       (eMode = 0)
      //   [6] Sky sUSDS balanceOf      (1000 shares — non-zero → position emitted)
      //   [7] Sky sUSDS maxWithdraw    (500 USDS — decoded by scanner for pricing)
      mockAggregate3StaticCall.mockResolvedValueOnce([
        [true, encodeNoPositionAccountData()], // Aave: no position
        [true, encodeEMode()],
        [true, encodeUint256(BigInt(0))], // stETH: 0
        [true, encodeUint256(BigInt(0))], // wstETH: 0
        [true, encodeActiveLoanAccountData()], // Spark: active loan → spark position
        [true, encodeEMode()],
        [true, encodeUint256(skyShares)], // Sky balanceOf: non-zero
        [true, encodeUint256(skyMaxWithdraw)], // Sky maxWithdraw: USDS amount
      ]);

      const { scanAddress } = await import("@/lib/scan/scanner");
      const result = await scanAddress(TEST_RAW);

      // Two positions: spark (active loan) + sky (priced sUSDS savings).
      expect(result.positions).toHaveLength(2);

      // Spark position
      const sparkPos = result.positions.find((p) => p.protocol === "spark");
      expect(sparkPos).toBeDefined();
      expect(sparkPos?.chainId).toBe(1);
      // normalizeHealthFactor: 1.8 WAD → 1.8 (4-decimal float)
      expect(sparkPos?.healthFactor).toBeCloseTo(1.8, 3);
      expect(sparkPos?.noActiveLoan).toBeFalsy();

      // Sky position
      const skyPos = result.positions.find((p) => p.protocol === "sky");
      expect(skyPos).toBeDefined();
      expect(skyPos?.chainId).toBe(1);
      expect(skyPos?.healthFactor).toBeNull();
      expect(skyPos?.noActiveLoan).toBe(true);

      // Sky usdValue: (Number(skyMaxWithdraw) / 1e18) * usdsPrice
      // = (500000000000000000000 / 1e18) * 0.9997 = 500 * 0.9997 = 499.85
      const expectedUsdValue = (Number(skyMaxWithdraw) / 1e18) * usdsPrice;
      expect(skyPos?.totalCollateralUsd).not.toBeNull();
      expect(skyPos?.totalCollateralUsd).toBeCloseTo(expectedUsdValue, 1);
      expect(skyPos?.suppliedAssets[0]?.usdValue).toBeCloseTo(
        expectedUsdValue,
        1
      );
    });

    it('resilient: Sky maxWithdraw returns [true, "0x"] — emits unpriced Sky position without sinking the chain (CR-01)', async () => {
      setupCacheMissDb();

      mockGetEnabledChains.mockResolvedValue([
        { id: "eth-1", chainId: 1, name: "Ethereum", isEnabled: true },
      ]);

      const skyShares = BigInt("1000000000000000000000"); // 1000 sUSDS

      // Slot 7 (Sky maxWithdraw) reports success but returns empty "0x" data —
      // a non-conformant vault. The pricing decode must NOT throw and mark the
      // whole chain unavailable; the Sky position is still emitted, unpriced.
      mockAggregate3StaticCall.mockResolvedValueOnce([
        [true, encodeNoPositionAccountData()], // Aave: no position
        [true, encodeEMode()],
        [true, encodeUint256(BigInt(0))], // stETH: 0
        [true, encodeUint256(BigInt(0))], // wstETH: 0
        [true, encodeNoPositionAccountData()], // Spark: no position
        [true, encodeEMode()],
        [true, encodeUint256(skyShares)], // Sky balanceOf: non-zero → position
        [true, "0x"], // Sky maxWithdraw: malformed empty data
      ]);

      const { scanAddress } = await import("@/lib/scan/scanner");
      const result = await scanAddress(TEST_RAW);

      // Chain 1 was NOT marked unavailable — the decode failure was swallowed.
      expect(result.unavailableChains.some((c) => c.chainId === 1)).toBe(false);

      // The Sky position is still emitted, with no USD value.
      const skyPos = result.positions.find((p) => p.protocol === "sky");
      expect(skyPos).toBeDefined();
      expect(skyPos?.suppliedAssets[0]?.usdValue).toBeNull();
      expect(skyPos?.totalCollateralUsd).toBeNull();
    });
  });

  describe("isContractCode — address-kind bytecode classification", () => {
    it("classifies empty code as EOA", async () => {
      const { isContractCode } = await import("@/lib/scan/scanner");
      expect(isContractCode("0x")).toBe(false);
    });

    it("classifies deployed bytecode as contract", async () => {
      const { isContractCode } = await import("@/lib/scan/scanner");
      expect(isContractCode("0x608060405234801561001057600080fd5b50")).toBe(
        true
      );
    });

    it("classifies an EIP-7702 delegation designator as EOA", async () => {
      const { isContractCode } = await import("@/lib/scan/scanner");
      // vitalik.eth's live mainnet designator: 0xef0100 || delegate address.
      expect(
        isContractCode("0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d")
      ).toBe(false);
    });

    it("is case-insensitive on the designator prefix", async () => {
      const { isContractCode } = await import("@/lib/scan/scanner");
      expect(
        isContractCode("0xEF01005A7FC11397E9A8AD41BF10BF13F22B0A63F96F6D")
      ).toBe(false);
    });
  });
});
