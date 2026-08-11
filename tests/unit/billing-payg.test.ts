import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { paygBlockMessage } from "@/lib/billing/payg/errors";
import { getPaygPeriod, startOfUtcDay } from "@/lib/billing/payg/period";
import {
  isValidUsdcDecimal,
  usdcDecimalToRaw,
  usdcRawToDecimal,
} from "@/lib/billing/payg/usdc";
import { isFeatureEnabled } from "@/lib/features/check";
import type { FeatureId } from "@/lib/features/types";

const PAID_NODE_FEATURES: FeatureId[] = [
  "action.http-request",
  "action.code",
  "action.webhook",
  "action.database-query",
];

describe("PAYG does not unlock paid nodes (free-tier feature only)", () => {
  it("keeps paid-node features gated to paid plans", () => {
    for (const feature of PAID_NODE_FEATURES) {
      expect(isFeatureEnabled(feature, "free")).toBe(false);
      expect(isFeatureEnabled(feature, "pro")).toBe(true);
    }
  });
});

describe("USDC 6-decimal raw conversion", () => {
  it("converts a decimal string to raw units", () => {
    expect(usdcDecimalToRaw("0.0075")).toBe(BigInt(7500));
    expect(usdcDecimalToRaw("1")).toBe(BigInt(1_000_000));
    expect(usdcDecimalToRaw("10")).toBe(BigInt(10_000_000));
  });

  it("parses a cap typed with a leading or trailing dot", () => {
    // The billing modal lets a user type ".5" or "5."; both are valid amounts.
    expect(usdcDecimalToRaw(".5")).toBe(BigInt(500_000));
    expect(usdcDecimalToRaw("0.5")).toBe(BigInt(500_000));
    expect(usdcDecimalToRaw("5.")).toBe(BigInt(5_000_000));
  });

  it("returns 0 for malformed input", () => {
    expect(usdcDecimalToRaw("")).toBe(BigInt(0));
    expect(usdcDecimalToRaw("abc")).toBe(BigInt(0));
  });

  it("formats raw back to a decimal string", () => {
    expect(usdcRawToDecimal(BigInt(7500))).toBe("0.007500");
  });
});

describe("USDC decimal validation (spend caps)", () => {
  it("accepts well-formed non-negative decimals, incl. a leading/trailing dot", () => {
    for (const value of [
      "0",
      "1",
      "1.5",
      "0.01",
      "1000.000000",
      ".5",
      "0.5",
      "5.",
    ]) {
      expect(isValidUsdcDecimal(value)).toBe(true);
    }
  });

  it("rejects malformed values so a bad cap is not silently unlimited", () => {
    for (const value of ["abc", "-5", "1.2.3", "1e6", "", "  "]) {
      expect(isValidUsdcDecimal(value)).toBe(false);
    }
  });
});

describe("PAYG billing period (monthly window anchored to enable date)", () => {
  const anchor = new Date("2026-01-15T00:00:00Z");

  it("returns the window containing now", () => {
    const period = getPaygPeriod(anchor, new Date("2026-01-20T00:00:00Z"));
    expect(period.start.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("advances to later months", () => {
    const period = getPaygPeriod(anchor, new Date("2026-03-10T00:00:00Z"));
    expect(period.start.toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("clamps the day for short months (Jan 31 anchor -> Feb 28)", () => {
    const jan31 = new Date("2026-01-31T00:00:00Z");
    const period = getPaygPeriod(jan31, new Date("2026-02-15T00:00:00Z"));
    expect(period.start.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("startOfUtcDay zeroes the time", () => {
    expect(startOfUtcDay(new Date("2026-01-20T13:45:00Z")).toISOString()).toBe(
      "2026-01-20T00:00:00.000Z"
    );
  });
});

describe("PAYG block messages", () => {
  it("has an actionable message per reason", () => {
    expect(paygBlockMessage("insufficient_funds")).toContain("USDC");
    expect(paygBlockMessage("daily_cap")).toContain("Daily");
    expect(paygBlockMessage("period_cap")).toContain("period");
    expect(paygBlockMessage("payment_failed")).toContain("try again");
  });
});
