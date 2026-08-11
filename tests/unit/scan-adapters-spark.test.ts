/**
 * Spark adapter unit tests — RED phase (Wave 0 scaffold).
 *
 * These tests are intentionally failing: buildSparkCalls and decodeSparkResults
 * are throw-stubs ("not implemented — see plan 56-02"). GREEN implementation
 * lands in plan 56-02.
 *
 * TDD: tests written first (RED), implementation added after (GREEN).
 * Covers SCAN-03: SparkLend lending positions on Ethereum mainnet.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ethers } from "ethers";
import { buildSparkCalls, decodeSparkResults } from "@/lib/scan/adapters/spark";

// ─── Shared constants ─────────────────────────────────────────────────────────

const TEST_USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const SPARK_POOL_ETH = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987";

const MAX_UINT256 = BigInt(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

// ─── ABI encoding helpers ─────────────────────────────────────────────────────

// Minimal Aave V3 / SparkLend Pool ABI fragment for encoding test data.
// SparkLend Pool exposes the identical wire interface (RESEARCH.md Q3 [VERIFIED]).
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

let poolIface: ethers.Interface | null = null;
function getPoolIface(): ethers.Interface {
  if (!poolIface) {
    poolIface = new ethers.Interface(
      POOL_ABI_FRAGMENT as unknown as ethers.InterfaceAbi
    );
  }
  return poolIface;
}

/** ABI-encode getUserAccountData for an active-loan position. */
function encodeActiveLoanAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(800_000_000), // totalCollateralBase: $8.00 in 8-decimal USD base units
    BigInt(400_000_000), // totalDebtBase: $4.00
    BigInt(200_000_000), // availableBorrowsBase
    BigInt(8000), // currentLiquidationThreshold
    BigInt(7500), // ltv
    BigInt("1500000000000000000"), // healthFactor: 1.5 in WAD (1e18)
  ]);
}

/** ABI-encode getUserAccountData for a supply-only position (no debt). */
function encodeSupplyOnlyAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(100_000_000), // totalCollateralBase: $1.00
    BigInt(0), // totalDebtBase: no debt
    BigInt(0), // availableBorrowsBase
    BigInt(8000), // currentLiquidationThreshold
    BigInt(7500), // ltv
    MAX_UINT256, // healthFactor: sentinel for no-debt
  ]);
}

/** ABI-encode getUserAccountData for a no-position address (all zeros). */
function encodeZeroAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(0),
    BigInt(0),
    BigInt(0),
    BigInt(0),
    BigInt(0),
    MAX_UINT256,
  ]);
}

/** ABI-encode getUserEMode result (eMode category = 0). */
function encodeEMode(category = 0): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256"],
    [BigInt(category)]
  );
}

// ─── buildSparkCalls ─────────────────────────────────────────────────────────

describe("spark adapter — buildSparkCalls", () => {
  it("spark: chainId 1 (Ethereum) returns 2 calls targeting the SparkLend pool", () => {
    const calls = buildSparkCalls(TEST_USER, 1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.target).toBe(SPARK_POOL_ETH);
    expect(calls[1]?.target).toBe(SPARK_POOL_ETH);
    expect(calls[0]?.allowFailure).toBe(true);
    expect(calls[1]?.allowFailure).toBe(true);
  });

  it("spark: unregistered chainId (999) returns empty array", () => {
    const calls = buildSparkCalls(TEST_USER, 999);
    expect(calls).toHaveLength(0);
  });
});

// ─── decodeSparkResults ──────────────────────────────────────────────────────

describe("spark adapter — decodeSparkResults", () => {
  it("spark: active-loan position — HF normalised, protocol is 'spark'", () => {
    const results = [
      { success: true, returnData: encodeActiveLoanAccountData() },
      { success: true, returnData: encodeEMode(0) },
    ];

    const positions = decodeSparkResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.protocol).toBe("spark");
    expect(pos?.chainId).toBe(1);
    expect(pos?.healthFactor).not.toBeNull();
    expect(pos?.healthFactor).toBeCloseTo(1.5, 3);
    expect(pos?.noActiveLoan).toBeFalsy();
    expect(pos?.totalCollateralUsd).toBeCloseTo(8, 1);
    expect(pos?.totalDebtUsd).toBeCloseTo(4, 1);
    expect(pos?.emodeCategory).toBe(0);
  });

  it("spark: supply-only position — healthFactor null, noActiveLoan true", () => {
    const results = [
      { success: true, returnData: encodeSupplyOnlyAccountData() },
      { success: true, returnData: encodeEMode(0) },
    ];

    const positions = decodeSparkResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.protocol).toBe("spark");
    expect(pos?.healthFactor).toBeNull();
    expect(pos?.noActiveLoan).toBe(true);
    expect(pos?.totalCollateralUsd).toBeCloseTo(1, 1);
    expect(pos?.totalDebtUsd).toBe(0);
  });

  it("spark: no position (all totals zero) — returns empty array", () => {
    const results = [
      { success: true, returnData: encodeZeroAccountData() },
      { success: true, returnData: encodeEMode(0) },
    ];

    const positions = decodeSparkResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(0);
  });

  it("spark: eMode soft-miss (getUserEMode fails) — position still emitted, emodeCategory defaults to 0", () => {
    const results = [
      { success: true, returnData: encodeActiveLoanAccountData() },
      { success: false, returnData: "0x" }, // eMode sub-call failed
    ];

    const positions = decodeSparkResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.protocol).toBe("spark");
    expect(pos?.emodeCategory).toBe(0);
    expect(pos?.healthFactor).toBeCloseTo(1.5, 3);
  });

  it("spark: getUserAccountData sub-call fails — returns empty array", () => {
    const results = [
      { success: false, returnData: "0x" },
      { success: true, returnData: encodeEMode(0) },
    ];

    const positions = decodeSparkResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(0);
  });
});
