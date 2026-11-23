import { describe, expect, it } from "vitest";
import {
  MAX_PRIORITY_FEE_GWEI,
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
