import { describe, expect, it } from "vitest";
import {
  feeSettingsError,
  MAX_FEE_GWEI,
  MAX_PRIORITY_FEE_GWEI,
  parseMaxFeeGwei,
  priorityFeeGweiError,
} from "@/lib/web3/gas-defaults";

describe("priorityFeeGweiError", () => {
  it.each([undefined, null, "", "   "])("treats %j as unset", (value) => {
    expect(priorityFeeGweiError(value)).toBeUndefined();
  });

  it.each(["3", "0.25", " 5 ", 3, String(MAX_PRIORITY_FEE_GWEI)])(
    "accepts %j",
    (value) => {
      expect(priorityFeeGweiError(value)).toBeUndefined();
    }
  );

  it.each(["abc", "3gwei", "0", "-1", "Infinity", true, {}])(
    "rejects %j",
    (value) => {
      expect(priorityFeeGweiError(value)).toMatch(/positive number in gwei/);
    }
  );

  it("rejects a tip above the cap", () => {
    expect(priorityFeeGweiError(String(MAX_PRIORITY_FEE_GWEI + 1))).toBe(
      `Priority fee must not exceed ${MAX_PRIORITY_FEE_GWEI} gwei`
    );
  });
});

describe("feeSettingsError", () => {
  it("accepts both unset", () => {
    expect(feeSettingsError(undefined, "")).toBeUndefined();
  });

  it("accepts a max fee at or above the priority fee", () => {
    expect(feeSettingsError("3", "3")).toBeUndefined();
    expect(feeSettingsError("3", "50")).toBeUndefined();
  });

  it("accepts a max fee with no priority fee", () => {
    expect(feeSettingsError("", "50")).toBeUndefined();
  });

  it("reports the priority fee error first", () => {
    expect(feeSettingsError("abc", "abc")).toMatch(/^Priority fee/);
  });

  it("rejects a malformed or out-of-range max fee", () => {
    expect(feeSettingsError(undefined, "x")).toMatch(
      /^Max fee must be a positive number in gwei/
    );
    expect(feeSettingsError(undefined, String(MAX_FEE_GWEI + 1))).toBe(
      `Max fee must not exceed ${MAX_FEE_GWEI} gwei`
    );
  });

  it("rejects a max fee below the priority fee", () => {
    expect(feeSettingsError("5", "3")).toBe(
      "Max fee must be at least the priority fee"
    );
  });
});

describe("parseMaxFeeGwei", () => {
  it("converts gwei to wei", () => {
    expect(parseMaxFeeGwei("50")).toBe(BigInt(50e9));
    expect(parseMaxFeeGwei("0.5")).toBe(BigInt(5e8));
  });

  it("returns undefined when unset", () => {
    expect(parseMaxFeeGwei("")).toBeUndefined();
    expect(parseMaxFeeGwei(undefined)).toBeUndefined();
  });
});
