import { afterEach, describe, expect, it } from "vitest";
import { isBillingEnabled } from "@/lib/billing/feature-flag";

describe("isBillingEnabled", () => {
  const original = process.env.NEXT_PUBLIC_BILLING_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = undefined;
    } else {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = original;
    }
  });

  it("returns true when env var is 'true'", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    expect(isBillingEnabled()).toBe(true);
  });

  it("returns false when env var is 'false'", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    expect(isBillingEnabled()).toBe(false);
  });

  it("returns false when env var is not set", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = undefined;
    expect(isBillingEnabled()).toBe(false);
  });

  it("returns false when env var is empty string", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "";
    expect(isBillingEnabled()).toBe(false);
  });

  it("returns false when env var is '1'", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "1";
    expect(isBillingEnabled()).toBe(false);
  });
});
