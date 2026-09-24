import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

vi.mock("server-only", () => ({}));

const mockGetActiveDebtExecutions = vi.fn().mockResolvedValue(0);

vi.mock("@/lib/billing/execution-debt", () => ({
  getActiveDebtExecutions: (...args: unknown[]) =>
    mockGetActiveDebtExecutions(...args),
}));

const mockExecute = vi.fn();
Object.assign(db, { execute: mockExecute });

function mockSelectReturning(rows: Record<string, unknown>[]): void {
  const tail = {
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  };
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ ...tail, leftJoin: vi.fn(() => tail) }),
  } as unknown as ReturnType<typeof db.select>);
}

/**
 * A plan read that resolved: the organization row came back, carrying whatever
 * subscription it has. Null is an org with no subscription, which is free.
 */
function mockPlanRead(subscription: Record<string, unknown> | null): void {
  mockSelectReturning([{ orgId: "org_1", subscription }]);
}

/** The organization row itself did not come back, so the plan is unknown. */
function mockPlanUnresolved(): void {
  mockSelectReturning([]);
}

function mockExecuteReturning(rows: Record<string, unknown>[]): void {
  mockExecute.mockResolvedValue(rows);
}

import { __resetExecutionCountCacheForTest } from "@/lib/billing/execution-limit-core";
import type { BillingInterval, PlanName, TierKey } from "@/lib/billing/plans";
import {
  checkExecutionLimit,
  checkFeatureAccess,
  getOrgPlan,
  getOrgSubscription,
  getPriceId,
  resolvePriceId,
  resolveSubscriptionPlan,
} from "@/lib/billing/plans-server";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveDebtExecutions.mockResolvedValue(0);
  __resetExecutionCountCacheForTest();
});

describe("getOrgSubscription", () => {
  it("returns subscription row when found", async () => {
    const row = { id: "sub_1", plan: "pro", tier: "25k", status: "active" };
    mockSelectReturning([row]);

    const result = await getOrgSubscription("org_1");
    expect(result).toEqual(row);
  });

  it("returns undefined when no subscription exists", async () => {
    mockSelectReturning([]);

    const result = await getOrgSubscription("org_1");
    expect(result).toBeUndefined();
  });
});

describe("getOrgPlan", () => {
  it("returns plan name from subscription", async () => {
    mockSelectReturning([{ plan: "business" }]);

    const result = await getOrgPlan("org_1");
    expect(result).toBe("business");
  });

  it("returns 'free' when no subscription", async () => {
    mockSelectReturning([]);

    const result = await getOrgPlan("org_1");
    expect(result).toBe("free");
  });
});

describe("checkFeatureAccess", () => {
  it("returns true for full apiAccess on pro plan", async () => {
    mockSelectReturning([{ plan: "pro", tier: "25k" }]);

    const result = await checkFeatureAccess("org_1", "apiAccess");
    expect(result).toBe(true);
  });

  it("returns false for rate-limited apiAccess on free plan", async () => {
    mockSelectReturning([]);

    const result = await checkFeatureAccess("org_1", "apiAccess");
    expect(result).toBe(false);
  });

  it("returns true for numeric feature with non-zero value", async () => {
    mockSelectReturning([{ plan: "pro", tier: "25k" }]);

    const result = await checkFeatureAccess("org_1", "logRetentionDays");
    expect(result).toBe(true);
  });

  it("returns true for non-null SLA on business plan", async () => {
    mockSelectReturning([{ plan: "business", tier: "250k" }]);

    const result = await checkFeatureAccess("org_1", "sla");
    expect(result).toBe(true);
  });

  it("returns false for null SLA on free plan", async () => {
    mockSelectReturning([]);

    const result = await checkFeatureAccess("org_1", "sla");
    expect(result).toBe(false);
  });
});

describe("checkExecutionLimit", () => {
  it("admits without a downgrade when the plan cannot be established", async () => {
    mockPlanUnresolved();

    const result = await checkExecutionLimit("org_1");

    // Not the free plan's 5,000: that would gate an unlimited org and hand its
    // runs to pay-as-you-go, which charges the org's wallet per execution.
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: false,
      debtExecutions: 0,
      effectiveLimit: -1,
    });
  });

  it("allows unlimited plans (enterprise)", async () => {
    mockPlanRead({ plan: "enterprise", tier: null, status: "active" });

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: false,
      debtExecutions: 0,
      effectiveLimit: -1,
    });
  });

  it("allows free plan when under limit", async () => {
    mockPlanRead(null);
    mockExecuteReturning([{ count: 100 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: false,
      debtExecutions: 0,
      effectiveLimit: 5000,
    });
  });

  // The last run the plan includes. The count here is usage before this run, so
  // 4999 prior executions means this one is number 5000 of 5000: included, and
  // not flagged for the pay-as-you-go charge.
  it("does not flag the last included execution as billable", async () => {
    mockPlanRead(null);
    mockExecuteReturning([{ count: 4999 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: false,
      debtExecutions: 0,
      effectiveLimit: 5000,
    });
  });

  it("allows pro plan within limits without overage flag", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "active" });
    mockExecuteReturning([{ count: 1000 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: false,
      debtExecutions: 0,
      effectiveLimit: 25_000,
    });
  });

  it("allows pro plan over limit with overage details", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "active" });
    mockExecuteReturning([{ count: 30_000 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: true,
      paygOverflow: false,
      limit: 25_000,
      used: 30_000,
      overageRate: 2,
      debtExecutions: 0,
      effectiveLimit: 25_000,
    });
  });

  // Pay-as-you-go covers every free org past its included limit, so admission
  // allows the run and the per-execution charge is the gate.
  it("allows free plan at limit for the pay-as-you-go charge to gate", async () => {
    mockPlanRead(null);
    mockExecuteReturning([{ count: 5000 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: true,
      limit: 5000,
      used: 5000,
      debtExecutions: 0,
      effectiveLimit: 5000,
    });
  });

  it("allows free plan over limit for the pay-as-you-go charge to gate", async () => {
    mockPlanRead(null);
    mockExecuteReturning([{ count: 6000 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: true,
      isOverage: false,
      paygOverflow: true,
      limit: 5000,
      used: 6000,
      debtExecutions: 0,
      effectiveLimit: 5000,
    });
  });

  // Nothing downstream can charge with billing off, so the included limit has
  // to block again rather than letting free executions run without end.
  it("blocks free plan over limit when billing is disabled", async () => {
    const original = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    mockPlanRead(null);
    mockExecuteReturning([{ count: 6000 }]);

    try {
      const result = await checkExecutionLimit("org_1");
      expect(result).toEqual({
        allowed: false,
        limit: 5000,
        used: 6000,
        plan: "free",
        debtExecutions: 0,
        effectiveLimit: 5000,
      });
    } finally {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = original;
    }
  });

  it("blocks paid plan when canceled (overage disabled)", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "canceled" });
    mockExecuteReturning([{ count: 30_000 }]);

    const result = await checkExecutionLimit("org_1");
    expect(result).toEqual({
      allowed: false,
      limit: 25_000,
      used: 30_000,
      plan: "pro",
      debtExecutions: 0,
      effectiveLimit: 25_000,
    });
  });

  it("reduces effective limit by debt executions", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "active" });
    mockGetActiveDebtExecutions.mockResolvedValue(5000);
    mockExecuteReturning([{ count: 21_000 }]);

    // 21k is above effectiveLimit (20k) but below plan limit (25k),
    // so the org is blocked in the debt penalty zone (not overage).
    const result = await checkExecutionLimit("org_1");

    expect(result).toEqual({
      allowed: false,
      limit: 25_000,
      used: 21_000,
      plan: "pro",
      debtExecutions: 5000,
      effectiveLimit: 20_000,
    });
  });

  it("blocks paid plan when active debt exists despite overage support", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "active" });
    mockGetActiveDebtExecutions.mockResolvedValue(5000);
    mockExecuteReturning([{ count: 26_000 }]);

    const result = await checkExecutionLimit("org_1");

    expect(result).toEqual({
      allowed: false,
      limit: 25_000,
      used: 26_000,
      plan: "pro",
      debtExecutions: 5000,
      effectiveLimit: 20_000,
    });
  });

  it("blocks paid plan with large debt even when usage is low", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "active" });
    mockGetActiveDebtExecutions.mockResolvedValue(30_000);
    mockExecuteReturning([{ count: 50 }]);

    const result = await checkExecutionLimit("org_1");

    expect(result).toEqual({
      allowed: false,
      limit: 25_000,
      used: 50,
      plan: "pro",
      debtExecutions: 30_000,
      effectiveLimit: 100,
    });
  });

  it("blocks when usage exceeds debt-reduced limit", async () => {
    mockPlanRead({ plan: "pro", tier: "25k", status: "canceled" });
    mockGetActiveDebtExecutions.mockResolvedValue(10_000);
    mockExecuteReturning([{ count: 16_000 }]);

    const result = await checkExecutionLimit("org_1");

    expect(result).toEqual({
      allowed: false,
      limit: 25_000,
      used: 16_000,
      plan: "pro",
      debtExecutions: 10_000,
      effectiveLimit: 15_000,
    });
  });
});

const hasStripeEnv = process.env.STRIPE_PRICE_PRO_25K_MONTHLY !== undefined;

describe("resolvePriceId", () => {
  it.skipIf(!hasStripeEnv)(
    "resolves a known tiered price ID back to plan, tier, and interval",
    () => {
      const priceId = String(process.env.STRIPE_PRICE_PRO_25K_MONTHLY);

      const resolved = resolvePriceId(priceId);
      expect(resolved).toEqual({
        plan: "pro",
        tier: "25k",
        interval: "monthly",
      });
    }
  );

  it.skipIf(!hasStripeEnv)(
    "resolves enterprise price ID with null tier",
    () => {
      const priceId = String(process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY);

      const resolved = resolvePriceId(priceId);
      expect(resolved).toEqual({
        plan: "enterprise",
        tier: null,
        interval: "monthly",
      });
    }
  );

  it("returns undefined for unknown price ID", () => {
    const resolved = resolvePriceId("price_unknown_xyz");
    expect(resolved).toBeUndefined();
  });

  it("every getPriceId result can be resolved back (no orphaned keys)", () => {
    const plans: PlanName[] = ["pro", "business", "enterprise"];
    const tiers: Array<TierKey | null> = [
      "25k",
      "50k",
      "100k",
      "250k",
      "500k",
      "1m",
      null,
    ];
    const intervals: BillingInterval[] = ["monthly", "yearly"];

    for (const plan of plans) {
      for (const tier of tiers) {
        for (const interval of intervals) {
          const priceId = getPriceId(plan, tier, interval);
          if (priceId === undefined) {
            continue;
          }
          const resolved = resolvePriceId(priceId);
          expect(resolved).toBeDefined();
          expect(resolved?.plan).toBe(plan);
        }
      }
    }
  });
});

describe("resolveSubscriptionPlan", () => {
  it("falls back to subscription metadata for custom enterprise prices", () => {
    const resolved = resolveSubscriptionPlan("price_custom_acme_inc", {
      subscription: { plan: "enterprise", interval: "yearly" },
    });
    expect(resolved).toEqual({
      plan: "enterprise",
      tier: null,
      interval: "yearly",
    });
  });

  it("uses price metadata when subscription metadata is absent", () => {
    const resolved = resolveSubscriptionPlan("price_custom_globex", {
      price: { plan: "enterprise", interval: "monthly" },
    });
    expect(resolved).toEqual({
      plan: "enterprise",
      tier: null,
      interval: "monthly",
    });
  });

  it("subscription metadata wins over price metadata", () => {
    const resolved = resolveSubscriptionPlan("price_custom", {
      subscription: { plan: "enterprise", interval: "yearly" },
      price: { plan: "business", tier: "1m", interval: "monthly" },
    });
    expect(resolved?.plan).toBe("enterprise");
    expect(resolved?.interval).toBe("yearly");
  });

  it("returns null interval when metadata interval is missing", () => {
    const resolved = resolveSubscriptionPlan("price_custom", {
      subscription: { plan: "enterprise" },
    });
    expect(resolved?.interval).toBeNull();
  });

  it("ignores invalid plan names in metadata", () => {
    const resolved = resolveSubscriptionPlan("price_unknown", {
      subscription: { plan: "platinum" as unknown as string },
    });
    expect(resolved).toBeUndefined();
  });

  it("returns undefined when neither env-var map nor metadata can resolve", () => {
    const resolved = resolveSubscriptionPlan("price_unknown_xyz");
    expect(resolved).toBeUndefined();
  });

  it("env-var price ID takes precedence over metadata", () => {
    if (!hasStripeEnv) {
      return;
    }
    const priceId = String(process.env.STRIPE_PRICE_PRO_25K_MONTHLY);
    const resolved = resolveSubscriptionPlan(priceId, {
      subscription: { plan: "enterprise", interval: "yearly" },
    });
    // env-var match wins, metadata ignored
    expect(resolved).toEqual({
      plan: "pro",
      tier: "25k",
      interval: "monthly",
    });
  });
});
