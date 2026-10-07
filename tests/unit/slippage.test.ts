import { describe, expect, it } from "vitest";
import { applySlippageFloor } from "@/lib/web3/slippage";

const ONE_WETH = BigInt("1000000000000000000");

describe("applySlippageFloor", () => {
  it("takes 50 bps off the quote in bigint arithmetic by default", () => {
    expect(applySlippageFloor(BigInt(10_000))).toBe(BigInt(9950));
    expect(applySlippageFloor(ONE_WETH)).toBe(BigInt("995000000000000000"));
  });

  it("rounds down, never up", () => {
    expect(applySlippageFloor(BigInt(1))).toBe(BigInt(0));
    expect(applySlippageFloor(BigInt(201))).toBe(BigInt(199));
  });

  it("applies the caller's slippage when given", () => {
    expect(applySlippageFloor(BigInt(10_000), 100)).toBe(BigInt(9900));
    expect(applySlippageFloor(BigInt(10_000), 0)).toBe(BigInt(10_000));
  });
});
