import { describe, expect, it } from "vitest";

import { divideCeil } from "@/plugins/math/steps/decimal-core";

describe("math/decimal-core divideCeil", () => {
  it("rounds a positive fractional quotient upward", () => {
    expect(divideCeil(BigInt(5), BigInt(2))).toBe(BigInt(3));
  });

  it("preserves an exact quotient", () => {
    expect(divideCeil(BigInt(6), BigInt(2))).toBe(BigInt(3));
  });

  it("rounds signed quotients toward positive infinity", () => {
    expect(divideCeil(BigInt(-5), BigInt(2))).toBe(BigInt(-2));
    expect(divideCeil(BigInt(5), BigInt(-2))).toBe(BigInt(-2));
    expect(divideCeil(BigInt(-5), BigInt(-2))).toBe(BigInt(3));
  });

  it("rejects a zero denominator", () => {
    expect(() => divideCeil(BigInt(1), BigInt(0))).toThrow(
      "Cannot divide by zero."
    );
  });
});
