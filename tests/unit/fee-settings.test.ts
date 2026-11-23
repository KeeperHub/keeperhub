import { describe, expect, it } from "vitest";
import {
  MAX_FEE_GWEI,
  MAX_PRIORITY_FEE_GWEI,
  priorityFeeGweiError,
  resolveFeeOverrides,
} from "@/lib/web3/gas-defaults";

describe("priorityFeeGweiError", () => {
  it.each([undefined, null, "", "   "])("treats %j as unset", (value) => {
    expect(priorityFeeGweiError(value)).toBeUndefined();
  });

  it.each([
    "3",
    "0.25",
    " 5 ",
    3,
    "0.000000001",
    String(MAX_PRIORITY_FEE_GWEI),
  ])("accepts %j", (value) => {
    expect(priorityFeeGweiError(value)).toBeUndefined();
  });

  it.each([
    "abc",
    "3gwei",
    "-1",
    "Infinity",
    "0x5",
    "1e3",
    "0.0000000001",
    true,
    {},
  ])("rejects %j as not a plain decimal", (value) => {
    expect(priorityFeeGweiError(value)).toMatch(
      /^Priority fee must be a positive decimal number in gwei/
    );
  });

  it("rejects zero", () => {
    expect(priorityFeeGweiError("0")).toBe(
      "Priority fee must be greater than 0 gwei"
    );
  });

  it("rejects a tip above the cap", () => {
    expect(priorityFeeGweiError(`${MAX_PRIORITY_FEE_GWEI}.000000001`)).toBe(
      `Priority fee must not exceed ${MAX_PRIORITY_FEE_GWEI} gwei`
    );
  });
});

describe("resolveFeeOverrides", () => {
  it("returns no overrides when both are unset", () => {
    expect(resolveFeeOverrides(undefined, "")).toEqual({
      priorityFeeOverride: undefined,
      maxFeeOverride: undefined,
    });
  });

  it("converts gwei to wei exactly", () => {
    expect(resolveFeeOverrides("0.3", "50")).toEqual({
      priorityFeeOverride: BigInt(300_000_000),
      maxFeeOverride: BigInt(50_000_000_000),
    });
    expect(resolveFeeOverrides("0.000000001", undefined)).toEqual({
      priorityFeeOverride: BigInt(1),
      maxFeeOverride: undefined,
    });
  });

  it("accepts a max fee equal to the priority fee", () => {
    expect(resolveFeeOverrides("3", "3")).toEqual({
      priorityFeeOverride: BigInt(3e9),
      maxFeeOverride: BigInt(3e9),
    });
  });

  it("reports the priority fee error first", () => {
    expect(resolveFeeOverrides("abc", "abc")).toEqual({
      error: expect.stringMatching(/^Priority fee/),
    });
  });

  it("rejects a malformed or out-of-range max fee", () => {
    expect(resolveFeeOverrides(undefined, "x")).toEqual({
      error: expect.stringMatching(/^Max fee must be a positive decimal/),
    });
    expect(resolveFeeOverrides(undefined, String(MAX_FEE_GWEI + 1))).toEqual({
      error: `Max fee must not exceed ${MAX_FEE_GWEI} gwei`,
    });
  });

  it("rejects a max fee below the priority fee", () => {
    expect(resolveFeeOverrides("5", "3")).toEqual({
      error: "Max fee must be at least the priority fee",
    });
  });
});
