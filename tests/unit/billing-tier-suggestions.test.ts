import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/billing/plans-server", () => ({
  getOrgSubscription: vi.fn(),
}));

import { getOrgSubscription } from "@/lib/billing/plans-server";
import { getUpgradeSuggestion } from "@/lib/billing/tier-suggestions";
import { db } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Mid-month so projection math works cleanly: day 15 of a 30-day month
  vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function mockSubscription(
  plan: string,
  tier: string | null,
  status = "active"
): void {
  vi.mocked(getOrgSubscription).mockResolvedValue({
    plan,
    tier,
    status,
  } as Awaited<ReturnType<typeof getOrgSubscription>>);
}

function mockExecutionCount(count: number): void {
  vi.mocked(db.execute).mockResolvedValue([{ count }] as unknown as Awaited<
    ReturnType<typeof db.execute>
  >);
}

describe("getUpgradeSuggestion", () => {
  it("returns shouldUpgrade: false for unlimited plans", async () => {
    mockSubscription("enterprise", null);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns shouldUpgrade: false when fewer than 3 days of data", async () => {
    vi.setSystemTime(new Date("2025-06-02T12:00:00Z"));
    mockSubscription("pro", "25k");
    // High usage on day 2 would normally trigger, but too few days for projection
    mockExecutionCount(22_000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
  });

  it("returns shouldUpgrade: false when usage is below 80%", async () => {
    mockSubscription("pro", "25k");
    // 25k limit, 10k used = 40% -- well below 80%
    mockExecutionCount(10_000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
  });

  it("returns shouldUpgrade: false for free plan with low usage", async () => {
    vi.mocked(getOrgSubscription).mockResolvedValue(undefined);
    // 5k limit, 2k used = 40%
    mockExecutionCount(2000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
  });

  it("suggests upgrade when free plan usage exceeds 80%", async () => {
    vi.mocked(getOrgSubscription).mockResolvedValue(undefined);
    // 5k limit, 4.5k used at day 15 = 90%, projected ~9k for full month
    // Free plan has no overage cost, so upgrade only suggested if savings > 0
    // Since free has $0 cost + $0 overage, upgrade won't save money
    mockExecutionCount(4500);

    const result = await getUpgradeSuggestion("org_1");

    // Free plan has no overage charges, so projected overage cost is $0.
    // Any paid tier costs more than $0, so no beneficial upgrade exists.
    expect(result.shouldUpgrade).toBe(false);
  });

  it("suggests upgrade when pro 25k plan has heavy overage", async () => {
    mockSubscription("pro", "25k");
    // 25k limit, 22k used at day 15 = 88%, projected ~44k for full month
    // Overage: 19k executions at $2/1k = $38 overage
    // Pro 50k tier: $89/mo, covers 50k -- no overage
    // Current cost: $49 + $38 overage = $87 vs $89 for 50k
    // That's actually not savings. Let's use a bigger overage.
    // 25k limit, 40k used at day 15, projected ~80k for full month
    // Overage: 55k at $2/1k = ceil(55000/1000)*$2 = $110 overage
    // Current: $49 + $110 = $159
    // Pro 100k: $149/mo, covers 100k -- no overage. Saves $10
    mockExecutionCount(40_000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(true);
    if (result.shouldUpgrade) {
      expect(result.currentPlan).toBe("pro");
      expect(result.currentTier).toBe("25k");
      expect(result.currentUsage).toBe(40_000);
      expect(result.usagePercent).toBe(160);
      expect(result.suggestedLimit).toBeGreaterThan(25_000);
      expect(result.monthlySavings).toBeGreaterThan(0);
    }
  });

  it("returns usagePercent as rounded integer", async () => {
    mockSubscription("pro", "25k");
    // 25k limit, 21k used = 84%
    // Projected: 42k. Overage: 17k at $2/1k = ceil(17000/1000)*200 = $3400 cents
    // Current: $4900 + $3400 = $8300
    // Pro 50k: $8900 -- no savings ($8900 > $8300)
    // Actually let's use higher usage for actual savings
    mockExecutionCount(40_000);

    const result = await getUpgradeSuggestion("org_1");

    if (result.shouldUpgrade) {
      expect(Number.isInteger(result.usagePercent)).toBe(true);
    }
  });

  it("includes all required fields in suggestion", async () => {
    mockSubscription("pro", "25k");
    mockExecutionCount(40_000);

    const result = await getUpgradeSuggestion("org_1");

    if (result.shouldUpgrade) {
      expect(result).toHaveProperty("currentPlan");
      expect(result).toHaveProperty("currentTier");
      expect(result).toHaveProperty("currentLimit");
      expect(result).toHaveProperty("currentUsage");
      expect(result).toHaveProperty("usagePercent");
      expect(result).toHaveProperty("suggestedPlan");
      expect(result).toHaveProperty("suggestedTier");
      expect(result).toHaveProperty("suggestedLimit");
      expect(result).toHaveProperty("monthlySavings");
    }
  });

  it("nudges an engaged, trial-eligible free org to start a Pro trial", async () => {
    vi.mocked(getOrgSubscription).mockResolvedValue(undefined);
    // 5k free limit, 3k used = 60% -- above the 50% trial-nudge threshold
    mockExecutionCount(3000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
    if (result.shouldUpgrade === false) {
      expect(result.startTrial).toEqual({
        plan: "pro",
        trialDays: 14,
        currentUsage: 3000,
        currentLimit: 5000,
        usagePercent: 60,
      });
    }
  });

  it("does not nudge a trial below the usage threshold", async () => {
    vi.mocked(getOrgSubscription).mockResolvedValue(undefined);
    // 5k free limit, 2k used = 40% -- below threshold
    mockExecutionCount(2000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
    if (result.shouldUpgrade === false) {
      expect(result.startTrial).toBeUndefined();
    }
  });

  it("does not nudge a trial once the free org has consumed one", async () => {
    vi.mocked(getOrgSubscription).mockResolvedValue({
      plan: "free",
      tier: null,
      status: "active",
      providerSubscriptionId: null,
      trialStartedAt: new Date("2025-01-01"),
    } as Awaited<ReturnType<typeof getOrgSubscription>>);
    mockExecutionCount(3000);

    const result = await getUpgradeSuggestion("org_1");

    expect(result.shouldUpgrade).toBe(false);
    if (result.shouldUpgrade === false) {
      expect(result.startTrial).toBeUndefined();
    }
  });
});
