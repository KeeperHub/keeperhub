import { describe, expect, it } from "vitest";
import type { TrialInfo } from "@/components/billing/pricing-table/types";
import {
  getButtonLabel,
  isTrialSelection,
} from "@/components/billing/pricing-table/utils";

const ELIGIBLE: TrialInfo = { eligible: true, days: 14, tier: "25k" };

describe("isTrialSelection", () => {
  it("accepts Pro at the resolved trial tier", () => {
    expect(isTrialSelection(ELIGIBLE, "pro", "25k")).toBe(true);
  });

  it("rejects the other Pro tiers", () => {
    expect(isTrialSelection(ELIGIBLE, "pro", "50k")).toBe(false);
    expect(isTrialSelection(ELIGIBLE, "pro", "100k")).toBe(false);
  });

  it("rejects other plans", () => {
    expect(isTrialSelection(ELIGIBLE, "business", "250k")).toBe(false);
    expect(isTrialSelection(ELIGIBLE, "enterprise", null)).toBe(false);
    expect(isTrialSelection(ELIGIBLE, "free", null)).toBe(false);
  });

  it("rejects an ineligible or absent trial offer", () => {
    expect(
      isTrialSelection({ ...ELIGIBLE, eligible: false }, "pro", "25k")
    ).toBe(false);
    expect(isTrialSelection(undefined, "pro", "25k")).toBe(false);
  });

  it("follows the tier the server resolved, not a hardcoded 25k", () => {
    const at50k: TrialInfo = { eligible: true, days: 14, tier: "50k" };
    expect(isTrialSelection(at50k, "pro", "50k")).toBe(true);
    expect(isTrialSelection(at50k, "pro", "25k")).toBe(false);
  });
});

describe("getButtonLabel", () => {
  it("offers the trial when the selection carries trial days", () => {
    expect(getButtonLabel("pro", false, false, false, 14)).toBe(
      "Start 14-day free trial"
    );
  });

  it("falls back to the paid label without trial days", () => {
    expect(getButtonLabel("pro", false, false, false, null)).toBe(
      "Choose plan"
    );
    expect(getButtonLabel("pro", false, false, false)).toBe("Choose plan");
  });

  it("keeps the current-plan and loading labels ahead of the trial offer", () => {
    expect(getButtonLabel("pro", true, false, true, 14)).toBe("Current Plan");
    expect(getButtonLabel("pro", false, true, false, 14)).toBe(
      "Redirecting..."
    );
  });
});
