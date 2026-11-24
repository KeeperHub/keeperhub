import { describe, expect, it } from "vitest";
import {
  assertGasLimitFits,
  hasOutOfGasEvidence,
  networkGasLimit,
} from "@/lib/web3/gas-limit-error";

const SEPOLIA = 11_155_111;
const BASE = 8453;
const CAP = BigInt(2 ** 24);
const BLOCK = BigInt(30_000_000);

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
    expect(networkGasLimit(SEPOLIA, BigInt(0))).toBe(CAP);
    expect(networkGasLimit(BASE, BigInt(0))).toBeUndefined();
    expect(networkGasLimit(BASE, undefined)).toBeUndefined();
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
