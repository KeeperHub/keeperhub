import { describe, expect, it } from "vitest";
import { readGasLimitMultiplier } from "@/app/api/execute/_lib/gas-limit-multiplier";
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";

const MAX_GAS_LIMIT = { mode: "maxGasLimit", value: "500000" } as const;

describe("readGasLimitMultiplier (#1973)", () => {
  it("passes a multiplier string through to resolveGasLimitOverrides", () => {
    const forwarded = readGasLimitMultiplier("1.5");
    expect(forwarded).toBe("1.5");
    expect(resolveGasLimitOverrides(forwarded)).toEqual({
      multiplierOverride: 1.5,
    });
  });

  it("stringifies the maxGasLimit object so the absolute-limit branch still runs", () => {
    const forwarded = readGasLimitMultiplier(MAX_GAS_LIMIT);
    expect(forwarded).toBe(JSON.stringify(MAX_GAS_LIMIT));
    expect(resolveGasLimitOverrides(forwarded)).toEqual({
      gasLimitOverride: BigInt(500_000),
    });
  });

  it("clamps a sub-1.0 multiplier to 1.0x rather than shrinking the limit", () => {
    const forwarded = readGasLimitMultiplier("0.003");
    expect(forwarded).toBe("0.003");
    expect(resolveGasLimitOverrides(forwarded)).toEqual({
      multiplierOverride: 1,
    });
  });

  it("leaves a missing value undefined so the chain default applies", () => {
    expect(readGasLimitMultiplier(undefined)).toBeUndefined();
    expect(resolveGasLimitOverrides(undefined)).toEqual({});
  });
});
