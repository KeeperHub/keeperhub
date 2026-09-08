/**
 * getBillingStatsFromDb() must not price a trialing org into MRR.
 *
 * A trialing org carries a real (plan, tier) tuple, so the old tally added its
 * full list price to mrrCentsTotal while the customer paid nothing. On prod
 * that overstated MRR by 57% (8 trialing of 14 priced pro/25k subscriptions).
 *
 * The fix keeps trialing rows in mrrCentsByPlan, now labelled with
 * billingStatus, and counts only MRR_COMMITTED_STATUSES into the total.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// getBillingStatsFromDb issues four queries, always in this order:
//   1. orgs by (plan, tier, status)   2. executions per org
//   3. priced subscriptions for MRR   4. trial outcomes
// The stub below ignores every chain method and resolves to the next queued
// row set, so each test only has to describe the rows it cares about.
const queuedRows: unknown[][] = [];

function queueRows(...rowSets: unknown[][]): void {
  queuedRows.length = 0;
  queuedRows.push(...rowSets);
}

type QueryChain = Promise<unknown[]> & Record<string, () => QueryChain>;

function makeChain(): QueryChain {
  // A real Promise, so `await db.select()...` resolves natively. The builder
  // methods hang off it and return the same object, so any chain shape works.
  const chain = Promise.resolve(queuedRows.shift() ?? []) as QueryChain;
  for (const method of [
    "select",
    "from",
    "leftJoin",
    "innerJoin",
    "where",
    "groupBy",
    "orderBy",
    "limit",
  ]) {
    chain[method] = () => chain;
  }
  return chain;
}

// db-metrics.ts reads the dedicated metrics pool, not the app pool:
// `import { metricsDb as db } from "@/lib/db"`. Mocking `db` alone leaves
// metricsDb undefined, and getBillingStatsFromDb swallows the resulting
// error and returns empty stats, so every assertion would read 0.
vi.mock("@/lib/db", () => ({
  db: { select: () => makeChain() },
  metricsDb: { select: () => makeChain() },
}));

import { getBillingStatsFromDb } from "@/lib/metrics/db-metrics";

// Pro 25k lists at $49/mo (lib/billing/plans.ts), so 4900 cents per seat.
const PRO_25K_CENTS = 4900;

function proSub(status: string) {
  return { plan: "pro", tier: "25k", status };
}

/** Queue only the MRR query (3rd); the other three return no rows. */
function queueMrrRows(rows: unknown[]): void {
  queueRows([], [], rows, []);
}

describe("getBillingStatsFromDb MRR split", () => {
  beforeEach(() => {
    queuedRows.length = 0;
  });

  it("keeps trialing revenue out of the committed total", async () => {
    // The prod mix on 2026-08-13: 5 active, 8 trialing, 1 past_due.
    queueMrrRows([
      ...Array.from({ length: 5 }, () => proSub("active")),
      ...Array.from({ length: 8 }, () => proSub("trialing")),
      proSub("past_due"),
    ]);

    const stats = await getBillingStatsFromDb();

    // Committed = active (5) + past_due (1) = 6 x 4900 = 29400.
    expect(stats.mrrCentsTotal).toBe(6 * PRO_25K_CENTS);
    // Not the pre-fix figure of 14 x 4900 = 68600.
    expect(stats.mrrCentsTotal).not.toBe(14 * PRO_25K_CENTS);
  });

  it("still reports trial pipeline revenue as its own labelled series", async () => {
    queueMrrRows([
      ...Array.from({ length: 5 }, () => proSub("active")),
      ...Array.from({ length: 8 }, () => proSub("trialing")),
      proSub("past_due"),
    ]);

    const stats = await getBillingStatsFromDb();
    const find = (billingStatus: string) =>
      stats.mrrCentsByPlan.find(
        (e) =>
          e.plan === "pro" &&
          e.tier === "25k" &&
          e.billingStatus === billingStatus
      );

    expect(find("active")?.cents).toBe(5 * PRO_25K_CENTS);
    expect(find("trialing")?.cents).toBe(8 * PRO_25K_CENTS);
    expect(find("past_due")?.cents).toBe(1 * PRO_25K_CENTS);
    // One entry per status, not one merged (plan, tier) bucket.
    expect(stats.mrrCentsByPlan).toHaveLength(3);
  });

  it("counts past_due as committed, because the org stays on the plan", async () => {
    queueMrrRows([proSub("past_due")]);

    const stats = await getBillingStatsFromDb();

    expect(stats.mrrCentsTotal).toBe(PRO_25K_CENTS);
  });

  it("reports zero committed revenue when every subscription is trialing", async () => {
    queueMrrRows([proSub("trialing"), proSub("trialing")]);

    const stats = await getBillingStatsFromDb();

    expect(stats.mrrCentsTotal).toBe(0);
    expect(stats.mrrCentsByPlan).toEqual([
      {
        plan: "pro",
        tier: "25k",
        billingStatus: "trialing",
        cents: 2 * PRO_25K_CENTS,
      },
    ]);
  });

  it("prices an untiered enterprise subscription at zero without dropping the row", async () => {
    queueMrrRows([{ plan: "enterprise", tier: null, status: "active" }]);

    const stats = await getBillingStatsFromDb();

    // Prod carries 4 active enterprise orgs that contribute no MRR, because
    // they have no priced tier. The series must still exist so the zero is
    // visible rather than missing.
    expect(stats.mrrCentsTotal).toBe(0);
    expect(stats.mrrCentsByPlan).toEqual([
      { plan: "enterprise", tier: null, billingStatus: "active", cents: 0 },
    ]);
  });
});
