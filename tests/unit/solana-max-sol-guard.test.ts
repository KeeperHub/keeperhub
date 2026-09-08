import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PublicKey } from "@solana/web3.js";
import {
  assertMaxSolLamportsOutflow,
  computeFeePayerLamportsOutflow,
  parseRequiredMaxSolLamports,
} from "@/lib/web3/solana-max-sol-guard";

const FEE_PAYER = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const OTHER = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

describe("parseRequiredMaxSolLamports", () => {
  it("rejects a blank maxSol", () => {
    const result = parseRequiredMaxSolLamports("   ");
    expect(result).toEqual({
      error: expect.stringContaining("maxSol is required"),
    });
  });

  it("parses a decimal SOL amount to lamports", () => {
    const result = parseRequiredMaxSolLamports("1.5");
    expect(result).toEqual({ lamports: BigInt("1500000000") });
  });
});

describe("computeFeePayerLamportsOutflow", () => {
  it("returns the fee payer balance decrease", () => {
    const outflow = computeFeePayerLamportsOutflow({
      feePayer: FEE_PAYER,
      accountKeys: [FEE_PAYER, OTHER],
      preBalances: [1_000_000_000, 500_000_000],
      postBalances: [999_995_000, 500_000_000],
    });
    expect(outflow).toBe(BigInt(5000));
  });

  it("returns zero when the fee payer balance did not decrease", () => {
    const outflow = computeFeePayerLamportsOutflow({
      feePayer: FEE_PAYER,
      accountKeys: [FEE_PAYER],
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000],
    });
    expect(outflow).toBe(BigInt(0));
  });

  it("throws when the fee payer is missing from simulation accounts", () => {
    expect(() =>
      computeFeePayerLamportsOutflow({
        feePayer: FEE_PAYER,
        accountKeys: [OTHER],
        preBalances: [500_000_000],
        postBalances: [499_995_000],
      })
    ).toThrow("Fee payer not found");
  });
});

describe("assertMaxSolLamportsOutflow", () => {
  it("passes when outflow is within the ceiling", () => {
    expect(() =>
      assertMaxSolLamportsOutflow({
        outflowLamports: BigInt(5000),
        maxSolLamports: BigInt(1_000_000),
      })
    ).not.toThrow();
  });

  it("throws when outflow exceeds the ceiling", () => {
    expect(() =>
      assertMaxSolLamportsOutflow({
        outflowLamports: BigInt(2_000_000),
        maxSolLamports: BigInt(1_000_000),
      })
    ).toThrow("exceeding declared maxSol ceiling");
  });
});
