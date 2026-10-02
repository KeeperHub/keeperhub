import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOrgPlan: vi.fn(),
  logSystemWarn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  executionDebt: { organizationId: {}, status: {}, debtExecutions: {} },
  organization: { id: {} },
  organizationSubscriptions: { organizationId: {}, plan: {}, tier: {} },
}));
vi.mock("@/lib/billing/subscription-read", () => ({
  resolveOrgPlan: mocks.resolveOrgPlan,
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { BILLING: "BILLING" },
  logSystemWarn: mocks.logSystemWarn,
}));

import { confirmQuotaStatus } from "@/lib/billing/quota-threshold";
import type { QuotaStatus } from "@/lib/billing/quota-threshold-core";

const PERIOD_START = new Date("2026-09-01T00:00:00.000Z");

/**
 * A status as the counting paths build it when the subscription read comes
 * back empty: the free plan's included executions applied to whatever was
 * counted. This is the shape that reached a customer on an unlimited plan.
 */
function countedAsFree(used: number): QuotaStatus {
  return {
    organizationId: "org_1",
    plan: "free",
    planLabel: "Pay per execution",
    used,
    limit: 5000,
    includedLimit: 5000,
    debtExecutions: 0,
    usagePercent: Math.floor((used / 5000) * 100),
    threshold: 100,
    periodStart: PERIOD_START,
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    paygEligible: true,
    overageRatePerThousand: null,
  };
}

function subscription(plan: string, tier: string | null = null): unknown {
  return { plan, tier, planOverrides: null, status: "active" };
}

beforeEach(() => {
  mocks.resolveOrgPlan.mockReset();
  mocks.logSystemWarn.mockReset();
});

describe("confirmQuotaStatus", () => {
  it("drops an unlimited org that was counted against the free allowance", async () => {
    mocks.resolveOrgPlan.mockResolvedValue(subscription("enterprise"));

    expect(await confirmQuotaStatus(countedAsFree(310_340))).toBeNull();
  });

  it("reports the plan mismatch that produced the wrong figures", async () => {
    mocks.resolveOrgPlan.mockResolvedValue(subscription("enterprise"));

    await confirmQuotaStatus(countedAsFree(310_340));

    expect(mocks.logSystemWarn).toHaveBeenCalledWith(
      "BILLING",
      expect.stringContaining("[QuotaThreshold]"),
      undefined,
      expect.objectContaining({
        organization_id: "org_1",
        counted_plan: "free",
        confirmed_plan: "enterprise",
      })
    );
  });

  it.each([
    { plan: "pro", tier: null, limit: 25_000 },
    { plan: "pro", tier: "50k", limit: 50_000 },
    { plan: "pro", tier: "100k", limit: 100_000 },
    { plan: "business", tier: null, limit: 250_000 },
    { plan: "business", tier: "500k", limit: 500_000 },
    { plan: "business", tier: "1m", limit: 1_000_000 },
  ])(
    "resolves $plan/$tier to its own limit instead of the free allowance",
    async ({ plan, tier, limit }) => {
      mocks.resolveOrgPlan.mockResolvedValue(subscription(plan, tier));

      // Past the free allowance but inside this plan's, so the only way to
      // reach a threshold here is to still be using the free numbers.
      expect(await confirmQuotaStatus(countedAsFree(6000))).toBeNull();

      mocks.resolveOrgPlan.mockResolvedValue(subscription(plan, tier));
      const atLimit = await confirmQuotaStatus(countedAsFree(limit));

      expect(atLimit).toMatchObject({
        plan,
        limit,
        usagePercent: 100,
        threshold: 100,
      });
    }
  );

  it("keeps a genuine free-plan org at its threshold", async () => {
    mocks.resolveOrgPlan.mockResolvedValue(subscription("free"));

    expect(await confirmQuotaStatus(countedAsFree(5000))).toMatchObject({
      plan: "free",
      planLabel: "Pay per execution",
      limit: 5000,
      threshold: 100,
      paygEligible: true,
    });
    expect(mocks.logSystemWarn).not.toHaveBeenCalled();
  });

  it("keeps an org resolved as free on the free allowance", async () => {
    mocks.resolveOrgPlan.mockResolvedValue(subscription("free"));

    expect(await confirmQuotaStatus(countedAsFree(5000))).toMatchObject({
      plan: "free",
      limit: 5000,
      threshold: 100,
    });
  });

  it("honours a per-org limit override", async () => {
    mocks.resolveOrgPlan.mockResolvedValue({
      plan: "business",
      tier: null,
      planOverrides: { maxExecutionsPerMonth: 2_000_000 },
      status: "active",
    });

    expect(await confirmQuotaStatus(countedAsFree(310_340))).toBeNull();
  });

  it("drops an org that an unlimited override took off every threshold", async () => {
    mocks.resolveOrgPlan.mockResolvedValue({
      plan: "free",
      tier: null,
      planOverrides: { maxExecutionsPerMonth: -1 },
      status: "active",
    });

    expect(await confirmQuotaStatus(countedAsFree(310_340))).toBeNull();
  });

  it("sends nothing when the plan could not be established", async () => {
    mocks.resolveOrgPlan.mockResolvedValue(null);

    expect(await confirmQuotaStatus(countedAsFree(310_340))).toBeNull();
  });

  it("confirms inside the month the usage was counted in", async () => {
    mocks.resolveOrgPlan.mockResolvedValue(subscription("free"));

    const confirmed = await confirmQuotaStatus(countedAsFree(5000));

    expect(confirmed?.periodStart).toEqual(PERIOD_START);
    expect(confirmed?.periodEnd).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });
});
