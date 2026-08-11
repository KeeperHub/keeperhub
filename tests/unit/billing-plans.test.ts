import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ organizationSubscriptions: {} }));

import { getPlanLimits, PLANS } from "@/lib/billing/plans";
import { getPriceId, resolvePriceId } from "@/lib/billing/plans-server";

describe("getPriceId", () => {
  it("returns price ID for pro 25k monthly", () => {
    const id = getPriceId("pro", "25k", "monthly");
    expect(id).toBe(process.env.STRIPE_PRICE_PRO_25K_MONTHLY);
  });

  it("returns price ID for pro 50k yearly", () => {
    const id = getPriceId("pro", "50k", "yearly");
    expect(id).toBe(process.env.STRIPE_PRICE_PRO_50K_YEARLY);
  });

  it("returns price ID for business 250k monthly", () => {
    const id = getPriceId("business", "250k", "monthly");
    expect(id).toBe(process.env.STRIPE_PRICE_BUSINESS_250K_MONTHLY);
  });

  it("returns price ID for enterprise monthly (no tier needed)", () => {
    const id = getPriceId("enterprise", null, "monthly");
    expect(id).toBe(process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY);
  });

  it("returns price ID for enterprise yearly", () => {
    const id = getPriceId("enterprise", null, "yearly");
    expect(id).toBe(process.env.STRIPE_PRICE_ENTERPRISE_YEARLY);
  });

  it("returns undefined for free plan", () => {
    const id = getPriceId("free", null, "monthly");
    expect(id).toBeUndefined();
  });

  it("returns undefined for paid plan with null tier", () => {
    const id = getPriceId("pro", null, "monthly");
    expect(id).toBeUndefined();
  });
});

describe("resolvePriceId", () => {
  it("resolves pro 25k monthly price ID", () => {
    const priceId = process.env.STRIPE_PRICE_PRO_25K_MONTHLY ?? "";
    expect(priceId).not.toBe("");
    const resolved = resolvePriceId(priceId);
    expect(resolved).toEqual({
      plan: "pro",
      tier: "25k",
      interval: "monthly",
    });
  });

  it("resolves business 500k yearly price ID", () => {
    const priceId = process.env.STRIPE_PRICE_BUSINESS_500K_YEARLY ?? "";
    expect(priceId).not.toBe("");
    const resolved = resolvePriceId(priceId);
    expect(resolved).toEqual({
      plan: "business",
      tier: "500k",
      interval: "yearly",
    });
  });

  it("resolves enterprise monthly price ID", () => {
    const priceId = process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY ?? "";
    expect(priceId).not.toBe("");
    const resolved = resolvePriceId(priceId);
    expect(resolved).toEqual({
      plan: "enterprise",
      tier: null,
      interval: "monthly",
    });
  });

  it("returns undefined for unknown price ID", () => {
    expect(resolvePriceId("price_unknown_xyz")).toBeUndefined();
  });
});

describe("getPlanLimits", () => {
  it("returns free plan defaults", () => {
    const limits = getPlanLimits("free");
    expect(limits.maxExecutionsPerMonth).toBe(5000);
    expect(limits.gasCreditsCents).toBe(100);
    expect(limits.apiAccess).toBe("rate-limited");
    expect(limits.logRetentionDays).toBe(7);
    expect(limits.supportLevel).toBe("community");
    expect(limits.sla).toBeNull();
  });

  it("returns pro plan base limits", () => {
    const limits = getPlanLimits("pro");
    expect(limits.maxExecutionsPerMonth).toBe(25_000);
    expect(limits.apiAccess).toBe("full");
    expect(limits.logRetentionDays).toBe(30);
  });

  it("overrides executions for pro 50k tier", () => {
    const limits = getPlanLimits("pro", "50k");
    expect(limits.maxExecutionsPerMonth).toBe(50_000);
  });

  it("overrides executions for pro 100k tier", () => {
    const limits = getPlanLimits("pro", "100k");
    expect(limits.maxExecutionsPerMonth).toBe(100_000);
  });

  it("overrides executions for business 1m tier", () => {
    const limits = getPlanLimits("business", "1m");
    expect(limits.maxExecutionsPerMonth).toBe(1_000_000);
  });

  it("returns enterprise unlimited executions", () => {
    const limits = getPlanLimits("enterprise");
    expect(limits.maxExecutionsPerMonth).toBe(-1);
    expect(limits.sla).toBe("99.99%");
  });

  it("ignores unknown tier", () => {
    const limits = getPlanLimits("pro", "999k" as unknown as undefined);
    expect(limits.maxExecutionsPerMonth).toBe(25_000);
  });

  it("applies per-org overrides on top of plan defaults", () => {
    const limits = getPlanLimits("enterprise", null, {
      gasCreditsCents: 50_000,
      sla: "99.999%",
      logRetentionDays: 730,
    });
    expect(limits.gasCreditsCents).toBe(50_000);
    expect(limits.sla).toBe("99.999%");
    expect(limits.logRetentionDays).toBe(730);
    // Unspecified fields fall through to plan defaults
    expect(limits.maxExecutionsPerMonth).toBe(-1);
  });

  it("overrides win over tier-based execution caps", () => {
    const limits = getPlanLimits("pro", "25k", {
      maxExecutionsPerMonth: 500_000,
    });
    expect(limits.maxExecutionsPerMonth).toBe(500_000);
  });

  it("ignores undefined override values", () => {
    const limits = getPlanLimits("pro", "50k", {
      gasCreditsCents: undefined,
    });
    expect(limits.gasCreditsCents).toBe(500); // pro default
    expect(limits.maxExecutionsPerMonth).toBe(50_000);
  });
});

describe("PLANS structure", () => {
  it("has four plans", () => {
    expect(Object.keys(PLANS)).toEqual([
      "free",
      "pro",
      "business",
      "enterprise",
    ]);
  });

  it("free plan has no tiers", () => {
    expect(PLANS.free.tiers).toHaveLength(0);
  });

  it("pro plan has 3 tiers", () => {
    expect(PLANS.pro.tiers).toHaveLength(3);
    const keys = PLANS.pro.tiers.map((t) => t.key);
    expect(keys).toEqual(["25k", "50k", "100k"]);
  });

  it("business plan has 3 tiers", () => {
    expect(PLANS.business.tiers).toHaveLength(3);
    const keys = PLANS.business.tiers.map((t) => t.key);
    expect(keys).toEqual(["250k", "500k", "1m"]);
  });

  it("enterprise plan has no tiers", () => {
    expect(PLANS.enterprise.tiers).toHaveLength(0);
  });

  it("pro overage is enabled at $2/1000", () => {
    expect(PLANS.pro.overage.enabled).toBe(true);
    expect(PLANS.pro.overage.ratePerThousand).toBe(2);
  });

  it("business overage is enabled at $1.5/1000", () => {
    expect(PLANS.business.overage.enabled).toBe(true);
    expect(PLANS.business.overage.ratePerThousand).toBe(1.5);
  });

  it("free and enterprise have overage disabled", () => {
    expect(PLANS.free.overage.enabled).toBe(false);
    expect(PLANS.enterprise.overage.enabled).toBe(false);
  });
});
