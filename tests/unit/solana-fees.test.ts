import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeSolanaLamportFee,
  SOLANA_BASE_FEE_LAMPORTS,
} from "@/lib/web3/solana-fees";

describe("computeSolanaLamportFee", () => {
  it("returns only the base fee when compute units or priority fee are zero", () => {
    expect(computeSolanaLamportFee(BigInt(0), BigInt(100))).toBe(
      SOLANA_BASE_FEE_LAMPORTS
    );
    expect(computeSolanaLamportFee(BigInt(15_000), BigInt(0))).toBe(
      SOLANA_BASE_FEE_LAMPORTS
    );
  });

  it("adds priority lamports from consumed compute units", () => {
    expect(computeSolanaLamportFee(BigInt(15_000), BigInt(123))).toBe(
      BigInt(5001)
    );
  });
});
