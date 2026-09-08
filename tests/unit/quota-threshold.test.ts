import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  executionDebt: {},
  organizationSubscriptions: {},
}));

import {
  buildQuotaStatus,
  crossedQuotaThreshold,
  LOWEST_QUOTA_THRESHOLD,
} from "@/lib/billing/quota-threshold";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function status(params: {
  plan?: "free" | "pro" | "business" | "enterprise";
  used: number;
  debtExecutions?: number;
}) {
  return buildQuotaStatus({
    organizationId: "org_1",
    plan: params.plan ?? "free",
    tier: null,
    planOverrides: null,
    used: params.used,
    debtExecutions: params.debtExecutions ?? 0,
    now: NOW,
  });
}

describe("crossedQuotaThreshold", () => {
  it("returns null below the lowest threshold", () => {
    expect(crossedQuotaThreshold(0)).toBeNull();
    expect(crossedQuotaThreshold(79)).toBeNull();
  });

  it("returns 80 from 80 up to 99", () => {
    expect(crossedQuotaThreshold(80)).toBe(80);
    expect(crossedQuotaThreshold(99)).toBe(80);
  });

  it("returns the highest threshold reached, not the lowest", () => {
    expect(crossedQuotaThreshold(100)).toBe(100);
    expect(crossedQuotaThreshold(340)).toBe(100);
  });

  it("agrees with the exported lowest threshold", () => {
    expect(crossedQuotaThreshold(LOWEST_QUOTA_THRESHOLD)).toBe(
      LOWEST_QUOTA_THRESHOLD
    );
    expect(crossedQuotaThreshold(LOWEST_QUOTA_THRESHOLD - 1)).toBeNull();
  });
});

describe("buildQuotaStatus", () => {
  it("returns null for unlimited plans", () => {
    expect(status({ plan: "enterprise", used: 999_999 })).toBeNull();
  });

  it("labels the free plan the way it is sold, not the internal key", () => {
    // It includes an allowance and then charges per execution, so users know it
    // as Pay per execution.
    expect(status({ used: 4000 })?.planLabel).toBe("Pay per execution");
    expect(status({ plan: "pro", used: 20_000 })?.planLabel).toBe("Pro");
  });

  it("floors the percentage so a displayed 80% is always a fired 80%", () => {
    // 3999/5000 = 79.98%, which must not round up into a notification.
    const justUnder = status({ used: 3999 });
    expect(justUnder?.usagePercent).toBe(79);
    expect(justUnder?.threshold).toBeNull();

    const exactly = status({ used: 4000 });
    expect(exactly?.usagePercent).toBe(80);
    expect(exactly?.threshold).toBe(80);
  });

  it("reports 100 once the free quota is exhausted", () => {
    const reached = status({ used: 5000 });
    expect(reached?.usagePercent).toBe(100);
    expect(reached?.threshold).toBe(100);
  });

  it("counts against the debt-reduced limit, not the included limit", () => {
    // 1000 debt on a 5000 plan leaves 4000 effective; 3200 is 80% of that.
    const withDebt = status({ used: 3200, debtExecutions: 1000 });
    expect(withDebt?.includedLimit).toBe(5000);
    expect(withDebt?.limit).toBe(4000);
    expect(withDebt?.usagePercent).toBe(80);
    expect(withDebt?.threshold).toBe(80);
  });

  it("marks the period as the UTC month containing now", () => {
    const current = status({ used: 4000 });
    expect(current?.periodStart.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(current?.periodEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("reports overage pricing for plans that bill it, and none for free", () => {
    expect(status({ plan: "pro", used: 20_000 })?.overageRatePerThousand).toBe(
      2
    );
    expect(status({ used: 4000 })?.overageRatePerThousand).toBeNull();
  });
});

describe("buildQuotaStatus pay-as-you-go eligibility", () => {
  const original = process.env.NEXT_PUBLIC_BILLING_ENABLED;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = original;
  });

  it("is eligible on the free plan when billing is on", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    expect(status({ used: 4000 })?.paygEligible).toBe(true);
  });

  it("is not eligible on a paid plan", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    expect(status({ plan: "pro", used: 20_000 })?.paygEligible).toBe(false);
  });

  it("is not eligible when billing is off", () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    expect(status({ used: 4000 })?.paygEligible).toBe(false);
  });
});
