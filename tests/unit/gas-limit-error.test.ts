import { describe, expect, it } from "vitest";
import {
  assertGasLimitFits,
  hasOutOfGasEvidence,
} from "@/lib/web3/gas-limit-error";

const SEPOLIA = 11_155_111;
const BASE = 8453;
const CAP = BigInt(2 ** 24);
const BLOCK = BigInt(30_000_000);
const HYPEREVM = 999;
const HUGE = BigInt(10) ** BigInt(12);

describe("network gas limit", () => {
  it("accepts a limit exactly at the 2^24 cap or the block gas limit", () => {
    expect(() => assertGasLimitFits(CAP, SEPOLIA, BLOCK)).not.toThrow();
    expect(() => assertGasLimitFits(BLOCK, BASE, BLOCK)).not.toThrow();
  });

  it("refuses one gas above either", () => {
    expect(() => assertGasLimitFits(CAP + BigInt(1), SEPOLIA, BLOCK)).toThrow(
      `Gas Limit ${CAP + BigInt(1)} is above the network's limit of ${CAP}.`
    );
    expect(() => assertGasLimitFits(BLOCK + BigInt(1), BASE, BLOCK)).toThrow(
      `above the network's limit of ${BLOCK}`
    );
  });

  it("applies no 2^24 cap on a chain without it", () => {
    expect(() =>
      assertGasLimitFits(BigInt(20_000_000), BASE, BLOCK)
    ).not.toThrow();
  });

  it("reads a missing or zero block gas limit as unknown", () => {
    expect(() =>
      assertGasLimitFits(CAP + BigInt(1), SEPOLIA, BigInt(0))
    ).toThrow(`above the network's limit of ${CAP}`);
    expect(() => assertGasLimitFits(HUGE, BASE, BigInt(0))).not.toThrow();
    expect(() => assertGasLimitFits(HUGE, BASE, undefined)).not.toThrow();
  });

  it("does not take a small latest block's limit as the cap where block sizes mix", () => {
    // HyperEVM: small fast blocks of about 2 to 3M gas, a 30M block about once a minute.
    expect(() =>
      assertGasLimitFits(BigInt(10_000_000), HYPEREVM, BigInt(3_000_000))
    ).not.toThrow();
  });
});

describe("out-of-gas evidence", () => {
  const nodeError = (message: string, data: string | null = null) => ({
    data,
    info: { error: { message } },
  });

  it.each([
    "out of gas",
    "EVM error OutOfGas",
    "OOG",
    "ReentrancySentryOOG",
    "intrinsic gas too low",
    "gas required exceeds allowance (30000)",
  ])("counts %s", (message) => {
    expect(hasOutOfGasEvidence(nodeError(message))).toBe(true);
  });

  it("counts revert data nested under .error or .info.error", () => {
    expect(
      hasOutOfGasEvidence({
        message: "call failed",
        error: { message: "execution reverted", data: "0xdeadbeef" },
      })
    ).toBe(true);
    expect(
      hasOutOfGasEvidence({
        info: { error: { message: "execution reverted", data: "0xdeadbeef" } },
      })
    ).toBe(true);
  });

  it("counts revert data, but not empty data or other words", () => {
    expect(
      hasOutOfGasEvidence(nodeError("execution reverted", "0xdeadbeef"))
    ).toBe(true);
    expect(hasOutOfGasEvidence(nodeError("execution reverted", "0x"))).toBe(
      false
    );
    expect(hasOutOfGasEvidence(nodeError("rate limit reached"))).toBe(false);
  });
});
