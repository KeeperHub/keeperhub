/**
 * TEST-01 anchor: Scanner correctness guards — four in-file guard todos.
 *
 * Guard ownership:
 *   HF MAX_UINT256  — filled by Plan 05 (Wave 3)
 *   soft-miss       — filled by Plan 03 (Wave 2)
 *   proxy           — filled by Plan 03 (Wave 2)
 *   unavailable     — filled by Plan 03 (Wave 2)
 *
 * Sibling files own the remaining guards:
 *   depeg guard      — tests/unit/scan-pricing.test.ts  (Plan 04)
 *   rate-limit guard — tests/unit/scan-route.test.ts    (Plan 08)
 *
 * Shared helpers exported here (`encodeAccountData`, `AAVE_V3_POOL_ABI_FRAGMENT`)
 * are imported by sibling test files so encoding is consistent across the suite.
 *
 * Plan 05 additions:
 *   DAI exclusion (SCAN-15) — SCAN_EXCLUDED_STABLECOINS constant assertions +
 *   full scanAddress path asserts USDC + USDS surface, DAI absent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { decodeAaveV3Results } from "@/lib/scan/adapters/aave-v3";
import { executeMulticallBatch } from "@/lib/scan/multicall-batch";
import { resolveImplementationAddress } from "@/lib/scan/proxy-abi";
import { scanChains } from "@/lib/scan/scan-chains";
import type { AdapterCallDescriptor, ChainScanOutput } from "@/lib/scan/types";

// ─── Module mocks (hoisted before imports by vitest) ─────────────────────────

vi.mock("server-only", () => ({}));

// Mock function handles for DAI exclusion tests (declared before vi.mock so
// factories close over them — pattern from scan-orchestrator.test.ts).
const mockDbSelectFnForDai = vi.fn();
const mockDbInsertFnForDai = vi.fn();
const mockGetEnabledChainsForDai = vi.fn();
const mockFetchDefillamaPriceForDai = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/db", () => ({
  db: {
    execute: vi.fn(),
    select: mockDbSelectFnForDai,
    insert: mockDbInsertFnForDai,
  },
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockResolvedValue({
    executeWithFailover: vi
      .fn()
      .mockImplementation((fn: (provider: unknown) => unknown) => fn({})),
    getProvider: vi.fn().mockReturnValue({}),
  }),
}));

// Chain service: default no-op. Configured per-test in the DAI exclusion suite.
vi.mock("@/lib/rpc/chain-service", () => ({
  getEnabledChains: mockGetEnabledChainsForDai,
}));

// Zerion fallback: always returns empty (no-op stub in v1.13).
vi.mock("@/lib/scan/zerion-fallback", () => ({
  maybeZerionFallback: vi.fn().mockResolvedValue([]),
  isZerionEnabled: vi.fn().mockReturnValue(false),
}));

// DefiLlama price: configurable per-test. Default null (price unavailable).
vi.mock("@/lib/scan/price/defillama", () => ({
  fetchDefillamaPrice: mockFetchDefillamaPriceForDai,
}));

// Settable mock for aggregate3.staticCall.
// Sibling test files reassign via `mockAggregate3StaticCall.mockResolvedValueOnce(...)`.
// biome-ignore lint/suspicious/noExportsInTest: intentional shared test helper
export const mockAggregate3StaticCall = vi.fn();

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

// ─── Shared ABI fragment ─────────────────────────────────────────────────────

// Flat-return getUserAccountData — safe to decode with ethers v6.
// Do NOT use PoolDataProvider's getReserveData (nested-tuple decode bug).
// biome-ignore lint/suspicious/noExportsInTest: intentional shared test helper
export const AAVE_V3_POOL_ABI_FRAGMENT = [
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

// ─── Shared encode helper ─────────────────────────────────────────────────────

interface AccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  /** Raw health factor in WAD (1e18 = 1.0). Use BigInt(2)**BigInt(256) - 1n for MAX_UINT256. */
  healthFactor: bigint;
}

// Lazy-initialised to avoid top-level import of mocked ethers before mock hoisting.
let _poolIface: import("ethers").Interface | null = null;

function getPoolIface(): import("ethers").Interface {
  if (_poolIface === null) {
    // Require at call-time so the vi.mock("ethers") hoisting has already run.
    const { ethers } = require("ethers") as typeof import("ethers");
    _poolIface = new ethers.Interface(AAVE_V3_POOL_ABI_FRAGMENT);
  }
  return _poolIface;
}

/**
 * Encode a getUserAccountData return value using the real ethers Interface so
 * the ABI encoding matches what an on-chain contract would return.
 *
 * Returns a `[success, returnData]` tuple ready to splice into a mocked
 * aggregate3.staticCall result array.
 *
 * Use `BigInt(2) ** BigInt(256) - BigInt(1)` for the MAX_UINT256 health factor
 * (tsconfig targets ES2017; bigint literals with `n` suffix require ES2020).
 *
 * @param overrides Fields to override from healthy-loan defaults.
 */
// biome-ignore lint/suspicious/noExportsInTest: intentional shared test helper
export function encodeAccountData(
  overrides: Partial<AccountData>
): [boolean, string] {
  const defaults: AccountData = {
    totalCollateralBase: BigInt(1000),
    totalDebtBase: BigInt(500),
    availableBorrowsBase: BigInt(0),
    currentLiquidationThreshold: BigInt(8000),
    ltv: BigInt(7500),
    healthFactor: BigInt("2000000000000000000"), // 2.0 WAD
  };
  const d = { ...defaults, ...overrides };
  const returnData = getPoolIface().encodeFunctionResult("getUserAccountData", [
    d.totalCollateralBase,
    d.totalDebtBase,
    d.availableBorrowsBase,
    d.currentLiquidationThreshold,
    d.ltv,
    d.healthFactor,
  ]);
  return [true, returnData];
}

// ─── Guard todos ─────────────────────────────────────────────────────────────

describe("scanner correctness guards", () => {
  it("HF MAX_UINT256 or zero-debt -> healthFactor null + noActiveLoan true", () => {
    // Use BigInt() constructor — tsconfig target ES2017 does not support n-suffix literals.
    const MAX = BigInt(2) ** BigInt(256) - BigInt(1);

    // Supply-only user: zero debt, MAX_UINT256 health factor from Aave V3 contract.
    const [, accountDataZeroDebt] = encodeAccountData({
      healthFactor: MAX,
      totalDebtBase: BigInt(0),
      totalCollateralBase: BigInt(1000),
    });
    const eModeData = getPoolIface().encodeFunctionResult("getUserEMode", [
      BigInt(0),
    ]);

    const resultsNoLoan = [
      { success: true, returnData: accountDataZeroDebt },
      { success: true, returnData: eModeData },
    ];

    const positionsNoLoan = decodeAaveV3Results(
      resultsNoLoan,
      "0x0000000000000000000000000000000000000001",
      1
    );

    expect(positionsNoLoan[0]?.healthFactor).toBeNull();
    expect(positionsNoLoan[0]?.noActiveLoan).toBe(true);

    // Active loan: HF = 2.0 WAD with 500 base-unit debt -> healthFactor === 2.
    const [, accountDataLoan] = encodeAccountData({
      healthFactor: BigInt("2000000000000000000"), // 2.0 WAD
      totalDebtBase: BigInt(500),
      totalCollateralBase: BigInt(1000),
    });

    const resultsWithLoan = [
      { success: true, returnData: accountDataLoan },
      { success: true, returnData: eModeData },
    ];

    const positionsWithLoan = decodeAaveV3Results(
      resultsWithLoan,
      "0x0000000000000000000000000000000000000001",
      1
    );

    expect(positionsWithLoan[0]?.healthFactor).toBe(2);
    expect(positionsWithLoan[0]?.noActiveLoan).toBeFalsy();
  });

  it("Multicall3 soft-miss -> one failed sub-call leaves siblings intact", async () => {
    // Encode two realistic getUserAccountData return values for call 0 and call 2.
    const encoded0 = encodeAccountData({ totalDebtBase: BigInt(100) })[1];
    const encoded2 = encodeAccountData({ totalDebtBase: BigInt(300) })[1];

    // aggregate3 returns [success, returnData][]; index 1 simulates a soft-miss.
    mockAggregate3StaticCall.mockResolvedValueOnce([
      [true, encoded0],
      [false, "0x"],
      [true, encoded2],
    ]);

    const mockRpcManager: Pick<RpcProviderManager, "executeWithFailover"> = {
      executeWithFailover: vi
        .fn()
        .mockImplementation((fn: (provider: unknown) => unknown) => fn({})),
    };

    const calls: AdapterCallDescriptor[] = [
      {
        target: "0x0000000000000000000000000000000000000001",
        allowFailure: true,
        callData: "0xdeadbeef",
      },
      {
        target: "0x0000000000000000000000000000000000000002",
        allowFailure: true,
        callData: "0xcafebabe",
      },
      {
        target: "0x0000000000000000000000000000000000000003",
        allowFailure: true,
        callData: "0x12345678",
      },
    ];

    const results = await executeMulticallBatch(
      calls,
      mockRpcManager as unknown as RpcProviderManager
    );

    // All three results are returned; the soft-miss at index 1 does not abort siblings.
    expect(results).toHaveLength(3);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.returnData).toBe(encoded0);

    expect(results[1]?.success).toBe(false);
    expect(results[1]?.returnData).toBe("0x");

    expect(results[2]?.success).toBe(true);
    expect(results[2]?.returnData).toBe(encoded2);

    // Siblings decode to the values that were encoded — confirming data integrity.
    const poolIface = getPoolIface();
    const decoded0 = poolIface.decodeFunctionResult(
      "getUserAccountData",
      encoded0
    );
    const decoded2 = poolIface.decodeFunctionResult(
      "getUserAccountData",
      encoded2
    );
    expect(decoded0.totalDebtBase).toBe(BigInt(100));
    expect(decoded2.totalDebtBase).toBe(BigInt(300));
  });

  it("EIP-1967 proxy ABI -> impl slot resolves real implementation address", async () => {
    // Aave V3 Ethereum pool used as the known implementation address.
    const implAddr = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
    // EIP-1967 storage layout: 32 bytes = 12 zero bytes of padding + 20-byte address.
    const paddedStorage = `0x${"0".repeat(24)}${implAddr.slice(2).toLowerCase()}`;

    type StorageProvider = {
      getStorage(address: string, slot: string): Promise<string>;
    };

    const mockGetStorage = vi.fn().mockResolvedValue(paddedStorage);
    const mockProvider: StorageProvider = {
      getStorage: mockGetStorage as StorageProvider["getStorage"],
    };

    const result = await resolveImplementationAddress(
      "0x0000000000000000000000000000000000000001",
      mockProvider
    );

    // Returned address must be EIP-55 checksummed.
    expect(result).toBe(implAddr);

    // Non-proxy contract: zero slot value -> null (address is zero address).
    const zeroStorage = `0x${"0".repeat(64)}`;
    mockGetStorage.mockResolvedValue(zeroStorage);

    const nullResult = await resolveImplementationAddress(
      "0x0000000000000000000000000000000000000001",
      mockProvider
    );
    expect(nullResult).toBeNull();
  });

  it("partial chain -> slow/failed chain yields unavailableChains[], not 500", async () => {
    const chainAOutput: ChainScanOutput = {
      chainId: 1,
      positions: [],
      stablecoins: [],
    };

    // Chain 1 resolves; chain 2 rejects simulating an RPC failure.
    const mockScanOneChain = (chainId: number): Promise<ChainScanOutput> => {
      if (chainId === 1) {
        return Promise.resolve(chainAOutput);
      }
      return Promise.reject(new Error("chainB RPC connection timeout"));
    };

    const { chainOutputs, unavailableChains } = await scanChains(
      [1, 2],
      mockScanOneChain
    );

    // The resolved chain's data is present in chainOutputs.
    expect(chainOutputs.map((o) => o.chainId)).toStrictEqual([1]);

    // The rejected chain surfaces as an unavailable marker, not a thrown error.
    expect(unavailableChains.map((u) => u.chainId)).toStrictEqual([2]);

    // The reason must not contain RPC URL/key material.
    const [unavailable] = unavailableChains;
    expect(unavailable?.reason).not.toContain("http");
    expect(unavailable?.reason).not.toContain("apikey");
    expect(unavailable?.reason).not.toContain("key=");

    // Verify scanChains itself never throws even when all chains fail.
    await expect(scanChains([2], mockScanOneChain)).resolves.toMatchObject({
      chainOutputs: [],
      unavailableChains: [{ chainId: 2 }],
    });
  });
});

// ─── DAI exclusion (SCAN-15) ─────────────────────────────────────────────────

describe("DAI exclusion (SCAN-15)", () => {
  // Fake token addresses for the stablecoin DB query mock.
  // These are clearly test-only values — no collisions with real registry addresses.
  const USDC_ADDR = "0x0000000000000000000000000000000000000011";
  const DAI_ADDR = "0x0000000000000000000000000000000000000012";
  const USDS_ADDR = "0x0000000000000000000000000000000000000013";

  const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  beforeEach(() => {
    vi.clearAllMocks();

    // Ethereum mainnet is the only scannable chain in these tests.
    mockGetEnabledChainsForDai.mockResolvedValue([
      { id: "eth-1", chainId: 1, name: "Ethereum", isEnabled: true },
    ]);

    // Cache writes are best-effort and wrapped in try-catch — just resolve.
    mockDbInsertFnForDai.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    });

    // DefiLlama returns $1.00 for any token (USDC + USDS pricing).
    mockFetchDefillamaPriceForDai.mockResolvedValue(1.0);
  });

  it("SCAN_EXCLUDED_STABLECOINS contains DAI but not USDS or USDC", async () => {
    const { SCAN_EXCLUDED_STABLECOINS } = await import("@/lib/scan/scanner");
    expect(SCAN_EXCLUDED_STABLECOINS.has("DAI")).toBe(true);
    expect(SCAN_EXCLUDED_STABLECOINS.has("USDS")).toBe(false);
    expect(SCAN_EXCLUDED_STABLECOINS.has("USDC")).toBe(false);
  });

  it("scanAddress excludes DAI from stablecoin results when registry returns [USDC, DAI, USDS]", async () => {
    // Encode helpers (lazy to avoid calling mocked ethers before hoisting).
    const { ethers } = await import("ethers");
    const encodeUint256 = (n: bigint): string =>
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);

    // no-position account data: totalCollateralBase=0 + totalDebtBase=0 → []
    const [, noPositionReturnData] = encodeAccountData({
      totalCollateralBase: BigInt(0),
      totalDebtBase: BigInt(0),
    });
    const eModeData = getPoolIface().encodeFunctionResult("getUserEMode", [
      BigInt(0),
    ]);

    // DB call sequence:
    //   1st: cache check → miss (empty)
    //   2nd: stablecoin query → [USDC, DAI, USDS] (scanner filters DAI out)
    let selectCallCount = 0;
    mockDbSelectFnForDai.mockImplementation(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) {
        // Cache check: miss
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
      }
      // Stablecoin query: return all three — scanner applies the exclusion filter
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { tokenAddress: USDC_ADDR, symbol: "USDC", decimals: 6 },
            { tokenAddress: DAI_ADDR, symbol: "DAI", decimals: 18 },
            { tokenAddress: USDS_ADDR, symbol: "USDS", decimals: 18 },
          ]),
        }),
      };
    });

    // Batch order: [aave x2, lido x2, spark x2, sky x2, stablecoins x2, chainlink x1]
    // After DAI exclusion chainStablecoins = [USDC, USDS] (2 calls).
    // On chain 1, USDC has a Chainlink feed; USDS does not → 1 Chainlink call.
    // Total: 2 + 2 + 2 + 2 + 2 + 1 = 11 slots.
    mockAggregate3StaticCall.mockResolvedValueOnce([
      // Aave: no position (both totals zero)
      [true, noPositionReturnData],
      [true, eModeData],
      // Lido: zero balance — no position
      [true, encodeUint256(BigInt(0))], // stETH
      [true, encodeUint256(BigInt(0))], // wstETH
      // Spark: no position (both totals zero)
      [true, noPositionReturnData],
      [true, eModeData],
      // Sky: zero balance — no position
      [true, encodeUint256(BigInt(0))], // sUSDS balanceOf
      [true, encodeUint256(BigInt(0))], // sUSDS maxWithdraw
      // Stablecoins (USDC at index 0, USDS at index 1 — DAI excluded):
      [true, encodeUint256(BigInt("1000000"))], // USDC: 1 USDC (6 dec)
      [true, encodeUint256(BigInt("1000000000000000000"))], // USDS: 1 USDS (18 dec)
      // Chainlink for USDC (fails → DefiLlama fallback):
      [false, "0x"],
    ]);

    const { scanAddress } = await import("@/lib/scan/scanner");
    const result = await scanAddress(TEST_ADDRESS);

    const symbols = result.stablecoins.map((s) => s.symbol);

    // USDC and USDS surface in the scan output.
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("USDS");

    // DAI is excluded by SCAN_EXCLUDED_STABLECOINS — must NOT appear.
    expect(symbols).not.toContain("DAI");
  });
});
