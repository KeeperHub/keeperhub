/**
 * Scan pricing unit tests — depeg guard (TEST-01 / SCAN-10).
 *
 * Covers: isDepegged, DEPEG_THRESHOLD, decodeChainlinkAnswer from
 * lib/scan/price/chainlink.ts.
 *
 * The depeg guard is one of the four TEST-01 correctness guards.  A
 * stablecoin price that deviates >= 0.5% from $1.00 must be flagged
 * `depegged: true`.  Stablecoins are NEVER priced at a hardcoded $1.00.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ethers } from "ethers";
import {
  DEPEG_THRESHOLD,
  decodeChainlinkAnswer,
  isDepegged,
} from "@/lib/scan/price/chainlink";

// ─── Depeg detection ──────────────────────────────────────────────────────────

describe("scan-pricing: depeg detection", () => {
  it("depeg: DEPEG_THRESHOLD constant is 0.005 (0.5%)", () => {
    expect(DEPEG_THRESHOLD).toBe(0.005);
  });

  it("depeg: price 0.994 deviates 0.6% below peg — depegged true", () => {
    expect(isDepegged(0.994)).toBe(true);
  });

  it("depeg: price 1.005000001 deviates just above 0.5% — depegged true", () => {
    expect(isDepegged(1.005_000_001)).toBe(true);
  });

  it("depeg: price 1.001 deviates only 0.1% — not depegged", () => {
    expect(isDepegged(1.001)).toBe(false);
  });

  it("depeg: price 0.997 deviates only 0.3% — not depegged", () => {
    expect(isDepegged(0.997)).toBe(false);
  });
});

// ─── decodeChainlinkAnswer ────────────────────────────────────────────────────

describe("scan-pricing: decodeChainlinkAnswer", () => {
  /**
   * ABI-encode a fake latestRoundData return payload using ethers AbiCoder.
   * latestRoundData outputs: (uint80 roundId, int256 answer, uint256 startedAt,
   *   uint256 updatedAt, uint80 answeredInRound)
   */
  function encodeLatestRoundData(answer: bigint): string {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    return abiCoder.encode(
      ["uint80", "int256", "uint256", "uint256", "uint80"],
      [BigInt(1), answer, BigInt(0), BigInt(1_000_000), BigInt(1)]
    );
  }

  it("depeg: decodes 8-decimal answer 100000000 to price 1.0", () => {
    // 100_000_000 / 1e8 = 1.0
    const encoded = encodeLatestRoundData(BigInt(100_000_000));
    expect(decodeChainlinkAnswer(encoded, 8)).toBe(1.0);
  });

  it("depeg: decodes 8-decimal answer 99400000 to price 0.994", () => {
    // 99_400_000 / 1e8 = 0.994
    const encoded = encodeLatestRoundData(BigInt(99_400_000));
    const price = decodeChainlinkAnswer(encoded, 8);
    expect(price).toBeCloseTo(0.994, 8);
  });

  it("depeg: returns null for zero answer (feed not yet reporting)", () => {
    const encoded = encodeLatestRoundData(BigInt(0));
    expect(decodeChainlinkAnswer(encoded, 8)).toBeNull();
  });

  it("depeg: returns null for malformed returnData (not a $0 guess)", () => {
    expect(decodeChainlinkAnswer("0x", 8)).toBeNull();
  });
});
