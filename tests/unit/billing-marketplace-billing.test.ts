import { describe, expect, it } from "vitest";
import {
  FREE_MARKETPLACE_BILLING_THRESHOLD_USDC,
  priceQualifiesForMarketplaceExemption,
} from "@/lib/billing/marketplace-billing";

describe("marketplace-billing", () => {
  it("threshold is 0.05 USDC", () => {
    expect(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC).toBe("0.05");
  });

  it("threshold parses as a number for numeric comparisons", () => {
    expect(Number(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC)).toBe(0.05);
  });

  describe("priceQualifiesForMarketplaceExemption", () => {
    it("returns false for prices below the threshold", () => {
      expect(priceQualifiesForMarketplaceExemption("0.04")).toBe(false);
      expect(priceQualifiesForMarketplaceExemption("0.0001")).toBe(false);
      expect(priceQualifiesForMarketplaceExemption("0")).toBe(false);
    });

    it("returns true for prices at or above the threshold", () => {
      expect(priceQualifiesForMarketplaceExemption("0.05")).toBe(true);
      expect(priceQualifiesForMarketplaceExemption("0.5")).toBe(true);
      expect(priceQualifiesForMarketplaceExemption("100")).toBe(true);
    });

    it("treats null/undefined/empty as 0 (does not qualify)", () => {
      expect(priceQualifiesForMarketplaceExemption(null)).toBe(false);
      expect(priceQualifiesForMarketplaceExemption(undefined)).toBe(false);
      expect(priceQualifiesForMarketplaceExemption("")).toBe(false);
    });
  });
});
