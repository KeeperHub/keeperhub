/**
 * Sky adapter unit tests — RED phase (Wave 0 scaffold).
 *
 * These tests are intentionally failing: buildSkyCalls and decodeSkyResults
 * are throw-stubs ("not implemented — see plan 56-02"). GREEN implementation
 * lands in plan 56-02.
 *
 * TDD: tests written first (RED), implementation added after (GREEN).
 * Covers SCAN-04: Sky sUSDS savings positions on Ethereum mainnet.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ethers } from "ethers";
import { buildSkyCalls, decodeSkyResults } from "@/lib/scan/adapters/sky";

// ─── Shared constants ─────────────────────────────────────────────────────────

const TEST_USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const SUSDS_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

// ─── ABI encoding helpers ─────────────────────────────────────────────────────

/** ABI-encode a uint256 as ERC20/ERC-4626 balanceOf or maxWithdraw return data. */
function encodeBalance(amount: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount]);
}

// ─── buildSkyCalls ────────────────────────────────────────────────────────────

describe("sky adapter — buildSkyCalls", () => {
  it("sky: chainId 1 (Ethereum) returns 2 calls — balanceOf and maxWithdraw", () => {
    const calls = buildSkyCalls(TEST_USER, 1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.allowFailure).toBe(true);
    expect(calls[1]?.allowFailure).toBe(true);
  });

  it("sky: both calls target the sUSDS vault address", () => {
    const calls = buildSkyCalls(TEST_USER, 1);
    expect(calls[0]?.target).toBe(SUSDS_ADDRESS);
    expect(calls[1]?.target).toBe(SUSDS_ADDRESS);
  });

  it("sky: unregistered chainId (999) returns empty array", () => {
    const calls = buildSkyCalls(TEST_USER, 999);
    expect(calls).toHaveLength(0);
  });
});

// ─── decodeSkyResults ────────────────────────────────────────────────────────

describe("sky adapter — decodeSkyResults", () => {
  it("sky: non-zero balanceOf — emits single 'sky' position with sUSDS asset", () => {
    const shares = BigInt("450000000000000000000"); // 450 sUSDS shares in wei

    const results = [
      { success: true, returnData: encodeBalance(shares) }, // balanceOf
      {
        success: true,
        returnData: encodeBalance(BigInt("499500000000000000000")),
      }, // maxWithdraw ~499.5 USDS
    ];

    const positions = decodeSkyResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.protocol).toBe("sky");
    expect(pos?.chainId).toBe(1);
    expect(pos?.healthFactor).toBeNull();
    expect(pos?.noActiveLoan).toBe(true);
    expect(pos?.totalDebtUsd).toBeNull();
    expect(pos?.borrowedAssets).toHaveLength(0);
    expect(pos?.suppliedAssets).toHaveLength(1);

    const asset = pos?.suppliedAssets[0];
    expect(asset?.symbol).toBe("sUSDS");
    expect(asset?.tokenAddress).toBe(SUSDS_ADDRESS);
    expect(asset?.usdValue).toBeNull(); // pricing happens in scanOneChain, not in adapter
  });

  it("sky: amount is a stringified bigint matching the balanceOf shares", () => {
    const shares = BigInt("450000000000000000000");

    const results = [
      { success: true, returnData: encodeBalance(shares) },
      {
        success: true,
        returnData: encodeBalance(BigInt("499500000000000000000")),
      },
    ];

    const positions = decodeSkyResults(results, TEST_USER, 1);
    const asset = positions[0]?.suppliedAssets[0];

    expect(typeof asset?.amount).toBe("string");
    expect(asset?.amount).toBe(String(shares));
  });

  it("sky: decimals smoke — sUSDS decimals is 18 (Assumption A1, confirmed from source)", () => {
    const shares = BigInt("1000000000000000000"); // 1 sUSDS in wei

    const results = [
      { success: true, returnData: encodeBalance(shares) },
      {
        success: true,
        returnData: encodeBalance(BigInt("1100000000000000000")),
      }, // ~1.1 USDS
    ];

    const positions = decodeSkyResults(results, TEST_USER, 1);
    expect(positions[0]?.suppliedAssets[0]?.decimals).toBe(18);
  });

  it("sky: zero balanceOf — returns empty array", () => {
    const results = [
      { success: true, returnData: encodeBalance(BigInt(0)) }, // balanceOf = 0
      { success: true, returnData: encodeBalance(BigInt(0)) }, // maxWithdraw = 0
    ];

    const positions = decodeSkyResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(0);
  });

  it("sky: balanceOf call failed (success: false) — soft-miss, returns empty array", () => {
    const results = [
      { success: false, returnData: "0x" }, // balanceOf failed
      { success: false, returnData: "0x" }, // maxWithdraw failed
    ];

    const positions = decodeSkyResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(0);
  });

  it("sky: decodeSkyResults does not throw on soft-miss", () => {
    const results = [
      { success: false, returnData: "0x" },
      { success: false, returnData: "0x" },
    ];

    expect(() => decodeSkyResults(results, TEST_USER, 1)).not.toThrow();
  });
});
