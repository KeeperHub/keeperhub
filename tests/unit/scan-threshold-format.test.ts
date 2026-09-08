/**
 * Unit tests for the preview-drawer threshold formatting helpers: raw base
 * units in / human-readable out, human back to base units, and the guard that
 * decides which confirmInputs fields are editable numbers vs read-only.
 */
import { describe, expect, it } from "vitest";
import {
  formatThresholdForDisplay,
  isEditableThreshold,
  parseThresholdToBaseUnits,
  thresholdDecimals,
} from "@/lib/scan/factory/threshold-format";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

const base: SuggestionDescriptor = {
  id: "x",
  name: "n",
  description: "d",
  category: "alert",
  chainId: 1,
  readOrWrite: "read",
  confirmInputs: {},
  riskNote: "r",
  usdValue: null,
};

describe("isEditableThreshold", () => {
  it("treats a base-unit integer threshold as editable", () => {
    expect(isEditableThreshold("threshold", "1400000000000000000")).toBe(true);
    expect(isEditableThreshold("gasThreshold", "10000000000000000")).toBe(true);
    expect(isEditableThreshold("alertThreshold", "5000000")).toBe(true);
  });

  it("leaves addresses and placeholder strings read-only", () => {
    expect(
      isEditableThreshold(
        "walletAddress",
        "0xabc0000000000000000000000000000000000000"
      )
    ).toBe(false);
    expect(
      isEditableThreshold(
        "alertThreshold",
        "Balance threshold in token base units"
      )
    ).toBe(false);
  });
});

describe("thresholdDecimals", () => {
  it("uses 18 for HF and gas, token decimals for alertThreshold", () => {
    expect(thresholdDecimals("threshold", base)).toBe(18);
    expect(thresholdDecimals("gasThreshold", base)).toBe(18);
    expect(thresholdDecimals("alertThreshold", { ...base, decimals: 6 })).toBe(
      6
    );
    expect(thresholdDecimals("alertThreshold", base)).toBe(18);
  });
});

describe("format / parse round-trip", () => {
  it("formats a raw 1e18 health factor to a short decimal", () => {
    expect(formatThresholdForDisplay("1380000000000000000", 18)).toBe("1.38");
    expect(formatThresholdForDisplay("10000000000000000", 18)).toBe("0.01");
  });

  it("formats a 6-decimal stablecoin amount", () => {
    expect(formatThresholdForDisplay("5000000", 6)).toBe("5");
    expect(formatThresholdForDisplay("1234560", 6)).toBe("1.23456");
  });

  it("parses a human value back to exact base units", () => {
    expect(parseThresholdToBaseUnits("1.4", 18)).toBe("1400000000000000000");
    expect(parseThresholdToBaseUnits("5", 6)).toBe("5000000");
  });

  it("rejects invalid or negative input", () => {
    expect(parseThresholdToBaseUnits("", 18)).toBeNull();
    expect(parseThresholdToBaseUnits("abc", 18)).toBeNull();
    expect(parseThresholdToBaseUnits("-1", 18)).toBeNull();
  });

  it("round-trips a displayed value back to the same base units", () => {
    const raw = "1380000000000000000";
    const human = formatThresholdForDisplay(raw, 18);
    expect(parseThresholdToBaseUnits(human, 18)).toBe(raw);
  });
});
