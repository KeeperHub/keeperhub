import { describe, expect, it } from "vitest";
import {
  MAX_PRIORITY_FEE_GWEI,
  parsePriorityFeeGwei,
  priorityFeeGweiError,
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

describe("parsePriorityFeeGwei", () => {
  it("converts gwei to wei exactly", () => {
    expect(parsePriorityFeeGwei("0.3")).toBe(BigInt(300_000_000));
    expect(parsePriorityFeeGwei("0.000000001")).toBe(BigInt(1));
    expect(parsePriorityFeeGwei(3)).toBe(BigInt(3e9));
  });

  it("returns undefined when unset or invalid", () => {
    expect(parsePriorityFeeGwei("")).toBeUndefined();
    expect(parsePriorityFeeGwei(undefined)).toBeUndefined();
    expect(parsePriorityFeeGwei("0x5")).toBeUndefined();
  });
});
