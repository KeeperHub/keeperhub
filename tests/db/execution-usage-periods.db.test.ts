/**
 * Per-period execution usage records against a real Postgres.
 *
 * The unit suite stubs the drizzle builder, so it asserts which branch runs and
 * never what the database does. Everything this file guards is invisible there:
 * the unique key that makes a second record a no-op rather than a duplicate,
 * the `billable` and period-boundary predicates in the count, and the fact that
 * direct executions land in the same figure from a different table and a
 * different timestamp column.
 */

import "dotenv/config";
import { and, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  directExecutions,
  executionUsagePeriods,
  organization,
  organizationSubscriptions,
  overageBillingRecords,
  users,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_usage_period_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WORKFLOW = `${PREFIX}wf`;
/**
 * An organization with NO `organization_subscriptions` row at all. On
 * production that is about 1,090 of 1,526 organizations, and roughly 400 of
 * them have run executions -- the free plan this record exists to cover. Both
 * writers used to enumerate the subscriptions table and so skipped every one.
 */
const ORG_NOSUB = `${PREFIX}org_nosub`;
const WORKFLOW_NOSUB = `${PREFIX}wf_nosub`;

const PERIOD_START = new Date(Date.UTC(2026, 0, 1));
const PERIOD_END = new Date(Date.UTC(2026, 1, 1));
/** Inside the period. */
const INSIDE = new Date(Date.UTC(2026, 0, 15));
/** On the exclusive upper bound, so it belongs to the next period. */
const ON_END = PERIOD_END;
/** Before the period opens. */
const BEFORE = new Date(Date.UTC(2025, 11, 31));

async function seed(plan = "pro", tier: string | null = "25k"): Promise<void> {
  await testDb
    .insert(users)
    .values({
      id: USER,
      name: "t",
      email: `${USER}@test.local`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await testDb
    .insert(organization)
    .values({ id: ORG, name: "t", slug: ORG, createdAt: new Date() })
    .onConflictDoNothing();
  await testDb
    .insert(workflows)
    .values({
      id: WORKFLOW,
      name: "t",
      userId: USER,
      organizationId: ORG,
      nodes: [],
      edges: [],
    })
    .onConflictDoNothing();
  await testDb
    .insert(organizationSubscriptions)
    .values({ id: `${PREFIX}sub`, organizationId: ORG, plan, tier })
    .onConflictDoUpdate({
      target: organizationSubscriptions.organizationId,
      set: { plan, tier },
    });

  // Deliberately no organizationSubscriptions row for this one.
  await testDb
    .insert(organization)
    .values({
      id: ORG_NOSUB,
      name: "t",
      slug: ORG_NOSUB,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  await testDb
    .insert(workflows)
    .values({
      id: WORKFLOW_NOSUB,
      name: "t",
      userId: USER,
      organizationId: ORG_NOSUB,
      nodes: [],
      edges: [],
    })
    .onConflictDoNothing();
}

async function addRun(
  id: string,
  startedAt: Date,
  billable = true
): Promise<void> {
  await testDb.insert(workflowExecutions).values({
    id: `${PREFIX}${id}`,
    workflowId: WORKFLOW,
    userId: USER,
    organizationId: ORG,
    status: "success",
    startedAt,
    billable,
  });
}

async function addDirectRun(id: string, createdAt: Date): Promise<void> {
  await testDb.insert(directExecutions).values({
    id: `${PREFIX}${id}`,
    organizationId: ORG,
    apiKeyId: `${PREFIX}key`,
    type: "protocol-action",
    status: "completed",
    createdAt,
  });
}

async function storedRows() {
  return await testDb
    .select()
    .from(executionUsagePeriods)
    .where(eq(executionUsagePeriods.organizationId, ORG));
}

/** In a fixed order, so two reads of the table can be compared whole. */
async function storedRowsById() {
  return (await storedRows()).sort((a, b) => a.id.localeCompare(b.id));
}

async function cleanup(): Promise<void> {
  for (const org of [ORG, ORG_NOSUB]) {
    await testDb
      .delete(executionUsagePeriods)
      .where(eq(executionUsagePeriods.organizationId, org));
    await testDb
      .delete(workflowExecutions)
      .where(eq(workflowExecutions.organizationId, org));
    await testDb
      .delete(directExecutions)
      .where(eq(directExecutions.organizationId, org));
    await testDb
      .delete(overageBillingRecords)
      .where(eq(overageBillingRecords.organizationId, org));
  }
  // closeCalendarMonthUsage writes for every organization that ran in the
  // span, so a shared database can pick up rows for organizations this file
  // never seeded. The span is synthetic, so anything inside it is ours.
  await testDb
    .delete(executionUsagePeriods)
    .where(
      and(
        gte(executionUsagePeriods.periodStart, new Date(Date.UTC(2025, 9, 1))),
        lte(executionUsagePeriods.periodStart, new Date(Date.UTC(2026, 2, 1)))
      )
    );
}

beforeEach(async () => {
  await cleanup();
  await seed();
});

afterAll(async () => {
  await cleanup();
  await testDb
    .delete(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, ORG));
  await testDb.delete(workflows).where(eq(workflows.id, WORKFLOW));
  await testDb.delete(workflows).where(eq(workflows.id, WORKFLOW_NOSUB));
  await testDb.delete(organization).where(eq(organization.id, ORG));
  await testDb.delete(organization).where(eq(organization.id, ORG_NOSUB));
  await testDb.delete(users).where(eq(users.id, USER));
  await queryClient.end();
});

/** A provider cycle the billing path raised a charge for. */
async function addOverageRecord(
  periodStart: Date,
  periodEnd: Date,
  status = "billed"
): Promise<void> {
  await testDb.insert(overageBillingRecords).values({
    id: `${PREFIX}overage`,
    organizationId: ORG,
    periodStart,
    periodEnd,
    executionLimit: 25_000,
    totalExecutions: 30_000,
    overageCount: 5000,
    overageRateCents: 200,
    totalChargeCents: 1000,
    status,
  });
}

/** A usage row as one of the writers would have left it. */
async function addUsageRow(
  id: string,
  periodStart: Date,
  periodEnd: Date,
  source: "subscription" | "calendar_month",
  totalExecutions = 5
): Promise<void> {
  await testDb.insert(executionUsagePeriods).values({
    id: `${PREFIX}${id}`,
    organizationId: ORG,
    periodStart,
    periodEnd,
    plan: "pro",
    tier: "25k",
    executionLimit: 25_000,
    workflowExecutions: totalExecutions,
    directExecutions: 0,
    totalExecutions,
    overageCount: 0,
    totalChargeCents: 0,
    source,
  });
}

function overlapping(
  rows: Awaited<ReturnType<typeof storedRows>>,
  start: Date,
  end: Date
): Awaited<ReturnType<typeof storedRows>> {
  return rows.filter((r) => r.periodStart < end && start < r.periodEnd);
}

/** After the period has closed, so the recorder accepts it. */
const AFTER_CLOSE = new Date(Date.UTC(2026, 1, 2));

describe("execution usage periods (real database)", () => {
  it("counts only billable runs inside the period, plus direct executions", async () => {
    const { countExecutionsForPeriod } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await addRun("in_1", INSIDE);
    await addRun("in_2", INSIDE);
    // Already paid for out of band: excluded from the billable count.
    await addRun("unbillable", INSIDE, false);
    // The upper bound is exclusive, so this belongs to the next period.
    await addRun("on_end", ON_END);
    await addRun("before", BEFORE);
    await addDirectRun("direct_1", INSIDE);
    await addDirectRun("direct_before", BEFORE);

    const counts = await countExecutionsForPeriod(
      ORG,
      PERIOD_START,
      PERIOD_END
    );

    expect(counts.workflowExecutions).toBe(2);
    expect(counts.directExecutions).toBe(1);
    expect(counts.total).toBe(3);
  });

  it("freezes the period, and a second call writes nothing", async () => {
    const { recordClosedPeriodUsage } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await addRun("in_1", INSIDE);
    await addDirectRun("direct_1", INSIDE);

    const first = await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
      },
      AFTER_CLOSE
    );
    expect(first).toEqual({ recorded: true, total: 2 });

    // More runs land against the same closed period. The stored figure must not
    // move: that is the whole guarantee.
    await addRun("in_2", INSIDE);
    const second = await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
      },
      AFTER_CLOSE
    );
    expect(second).toEqual({ recorded: false, reason: "already recorded" });

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].totalExecutions).toBe(2);
    expect(rows[0].workflowExecutions).toBe(1);
    expect(rows[0].directExecutions).toBe(1);
    expect(rows[0].plan).toBe("pro");
    expect(rows[0].executionLimit).toBe(25_000);
  });

  it("refuses a period that has not closed yet", async () => {
    const { recordClosedPeriodUsage } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await addRun("in_1", INSIDE);

    const result = await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
      },
      // Still inside the period.
      INSIDE
    );

    expect(result).toEqual({ recorded: false, reason: "period still open" });
    expect(await storedRows()).toHaveLength(0);
  });

  it("records a period the subscription ended before its end date", async () => {
    const { recordClosedPeriodUsage } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await addRun("in_1", INSIDE);

    // A cancellation bills the closing period now, so the count is final even
    // though the period's end date is still ahead. Without the override this
    // is the one period a customer is charged for and never recorded.
    const result = await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
        periodEndedEarly: true,
      },
      INSIDE
    );

    expect(result).toEqual({ recorded: true, total: 1 });
    expect(await storedRows()).toHaveLength(1);
  });

  it("records a free-plan organization, which never produces a charge", async () => {
    const { recordClosedPeriodUsage } = await import(
      "../../lib/billing/execution-usage-periods"
    );
    await seed("free", null);
    await addRun("in_1", INSIDE);

    const result = await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "calendar_month",
      },
      AFTER_CLOSE
    );

    expect(result).toEqual({ recorded: true, total: 1 });
    const rows = await storedRows();
    expect(rows[0].plan).toBe("free");
    expect(rows[0].source).toBe("calendar_month");
  });

  it("derives the overage from the limit that applied", async () => {
    const { recordClosedPeriodUsage } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
        counts: {
          workflowExecutions: 26_000,
          directExecutions: 0,
          total: 26_000,
        },
      },
      AFTER_CLOSE
    );

    const rows = await storedRows();
    expect(rows[0].overageCount).toBe(1000);
    expect(rows[0].totalChargeCents).toBe(0);
  });

  it("stamps the charge onto the record without touching the usage", async () => {
    const { recordClosedPeriodUsage, stampPeriodCharge } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await addRun("in_1", INSIDE);
    await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
      },
      AFTER_CLOSE
    );

    await stampPeriodCharge(ORG, PERIOD_START, PERIOD_END, 4200);

    const rows = await storedRows();
    expect(rows[0].totalChargeCents).toBe(4200);
    expect(rows[0].totalExecutions).toBe(1);
  });

  it("reads back only the periods asked about", async () => {
    const { getStoredUsageForPeriods, periodKey, recordClosedPeriodUsage } =
      await import("../../lib/billing/execution-usage-periods");

    const nextStart = PERIOD_END;
    const nextEnd = new Date(Date.UTC(2026, 2, 1));
    await addRun("in_1", INSIDE);
    await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
      },
      AFTER_CLOSE
    );

    const stored = await getStoredUsageForPeriods(ORG, [
      { periodStart: PERIOD_START, periodEnd: PERIOD_END },
      { periodStart: nextStart, periodEnd: nextEnd },
    ]);

    expect(
      stored.get(periodKey(PERIOD_START, PERIOD_END))?.totalExecutions
    ).toBe(1);
    expect(stored.has(periodKey(nextStart, nextEnd))).toBe(false);
  });

  it("reports which organizations already hold a record for a period", async () => {
    const { getRecordedOrganizationIds, recordClosedPeriodUsage } =
      await import("../../lib/billing/execution-usage-periods");

    await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "calendar_month",
      },
      AFTER_CLOSE
    );

    const recorded = await getRecordedOrganizationIds(
      [ORG, `${PREFIX}absent`],
      PERIOD_START,
      PERIOD_END
    );

    expect(recorded.has(ORG)).toBe(true);
    expect(recorded.has(`${PREFIX}absent`)).toBe(false);
  });

  it("keeps two adjacent periods apart under the unique key", async () => {
    const { recordClosedPeriodUsage } = await import(
      "../../lib/billing/execution-usage-periods"
    );

    await addRun("in_1", INSIDE);
    await addRun("next_1", ON_END);

    await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: "subscription",
      },
      AFTER_CLOSE
    );
    await recordClosedPeriodUsage(
      {
        organizationId: ORG,
        periodStart: PERIOD_END,
        periodEnd: new Date(Date.UTC(2026, 2, 1)),
        source: "subscription",
      },
      new Date(Date.UTC(2026, 2, 2))
    );

    const rows = await testDb
      .select()
      .from(executionUsagePeriods)
      .where(
        and(
          eq(executionUsagePeriods.organizationId, ORG),
          eq(executionUsagePeriods.source, "subscription")
        )
      );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.totalExecutions).sort()).toEqual([1, 1]);
  });
  describe("closeCalendarMonthUsage", () => {
    /** Somewhere inside the month AFTER the one under test, so it has closed. */
    const AFTER_MONTH = new Date(Date.UTC(2026, 1, 5));

    async function addNoSubRun(id: string, startedAt: Date): Promise<void> {
      await testDb.insert(workflowExecutions).values({
        id: `${PREFIX}${id}`,
        workflowId: WORKFLOW_NOSUB,
        userId: USER,
        organizationId: ORG_NOSUB,
        status: "success",
        startedAt,
        billable: true,
      });
    }

    it("records an organization that has no subscription row at all", async () => {
      await addNoSubRun("nosub_run", INSIDE);
      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );

      await closeCalendarMonthUsage(AFTER_MONTH);

      const [row] = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(eq(executionUsagePeriods.organizationId, ORG_NOSUB));

      expect(row).toBeDefined();
      expect(row?.source).toBe("calendar_month");
      expect(row?.totalExecutions).toBe(1);
      // No subscription row means the free-plan defaults, not a crash and not a
      // skip. This is the whole regression.
      expect(row?.plan).toBe("free");
      expect(row?.executionLimit).toBe(5000);
    });

    it("counts both halves and leaves runs outside the month alone", async () => {
      await addNoSubRun("nosub_in", INSIDE);
      await addNoSubRun("nosub_before", BEFORE);
      await addNoSubRun("nosub_on_end", ON_END);
      await testDb.insert(directExecutions).values({
        id: `${PREFIX}nosub_direct`,
        organizationId: ORG_NOSUB,
        apiKeyId: `${PREFIX}key`,
        type: "protocol-action",
        status: "completed",
        createdAt: INSIDE,
      });

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const [row] = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(
          and(
            eq(executionUsagePeriods.organizationId, ORG_NOSUB),
            eq(executionUsagePeriods.periodStart, PERIOD_START)
          )
        );

      expect(row?.workflowExecutions).toBe(1);
      expect(row?.directExecutions).toBe(1);
      expect(row?.totalExecutions).toBe(2);

      // The run before the month is not lost, it belongs to its own month.
      const [earlier] = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(
          and(
            eq(executionUsagePeriods.organizationId, ORG_NOSUB),
            eq(
              executionUsagePeriods.periodStart,
              new Date(Date.UTC(2025, 11, 1))
            )
          )
        );
      expect(earlier?.totalExecutions).toBe(1);
    });

    it("is idempotent, so a second run of the day writes nothing", async () => {
      await addNoSubRun("nosub_idem", INSIDE);
      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );

      const first = await closeCalendarMonthUsage(AFTER_MONTH);
      const second = await closeCalendarMonthUsage(AFTER_MONTH);

      expect(first.recorded).toBeGreaterThanOrEqual(1);
      expect(second.recorded).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(1);

      const rows = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(eq(executionUsagePeriods.organizationId, ORG_NOSUB));
      expect(rows).toHaveLength(1);
    });

    it("still records an organization whose subscription has ended", async () => {
      // Churned to free: the period columns are never cleared, so a gate that
      // reads them alone excluded this organization for good.
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "free",
          status: "canceled",
          currentPeriodStart: new Date(Date.UTC(2025, 11, 1)),
          currentPeriodEnd: new Date(Date.UTC(2025, 11, 31)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("churned_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const rows = await storedRows();
      const calendar = rows.filter((r) => r.source === "calendar_month");
      expect(calendar.length).toBeGreaterThan(0);
      expect(calendar[0]?.plan).toBe("free");

      // The lapsed window is the one handleScan feeds to billOverageForOrg, so
      // the close must not write a calendar row overlapping it. Nothing here
      // may cover the same instant twice, or any sum over this table double
      // counts and the unique key cannot see it.
      for (const a of rows) {
        for (const b of rows) {
          if (a.id === b.id) {
            continue;
          }
          const overlaps =
            a.periodStart < b.periodEnd && b.periodStart < a.periodEnd;
          expect(overlaps).toBe(false);
        }
      }
    });

    it("does not write over a provider window the scan already recorded", async () => {
      // A recorded subscription row is the authority for its window. The close
      // has to see it and stay out, even though the months around it are its
      // own to write.
      await testDb.insert(executionUsagePeriods).values({
        id: `${PREFIX}sub_row`,
        organizationId: ORG,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        plan: "pro",
        tier: "25k",
        executionLimit: 25_000,
        workflowExecutions: 5,
        directExecutions: 0,
        totalExecutions: 5,
        overageCount: 0,
        totalChargeCents: 0,
        source: "subscription",
      });
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "free",
          status: "canceled",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("covered_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("subscription");
    });

    it("still records the part of a month a provider cycle does not cover", async () => {
      // Conversion mid-month: the cycle starts partway through, so the days
      // before it belong to nobody unless the close clips and writes them.
      const conversion = new Date(Date.UTC(2026, 0, 20));
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "pro",
          tier: "25k",
          status: "active",
          currentPeriodStart: conversion,
          currentPeriodEnd: new Date(Date.UTC(2026, 1, 20)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("pre_conversion", new Date(Date.UTC(2026, 0, 5)));

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const [row] = await storedRows();
      expect(row).toBeDefined();
      expect(row?.periodStart.toISOString()).toBe(PERIOD_START.toISOString());
      expect(row?.periodEnd.toISOString()).toBe(conversion.toISOString());
      expect(row?.totalExecutions).toBe(1);
    });

    it("leaves a live provider cycle to the billing path", async () => {
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "pro",
          status: "active",
          currentPeriodStart: PERIOD_START,
          currentPeriodEnd: new Date(Date.UTC(2026, 6, 1)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("live_cycle_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      expect(await storedRows()).toHaveLength(0);
    });

    it("leaves a paid plan alone once its period has lapsed", async () => {
      // The keep-plan branch of subscription.deleted leaves a paid plan with a
      // lapsed period and no webhook ever follows, and handleScan selects that
      // exact shape. A gate reading only the period would write a second,
      // contradictory row here every month: the paid limit, a real overage
      // count, and a hardcoded zero charge.
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "pro",
          tier: "25k",
          status: "canceled",
          currentPeriodStart: new Date(Date.UTC(2025, 11, 1)),
          currentPeriodEnd: new Date(Date.UTC(2025, 11, 31)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("lapsed_paid_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      expect(await storedRows()).toHaveLength(0);
    });

    it("leaves a past_due paid plan alone", async () => {
      // past_due sits outside handleScan's filter entirely, so this org would
      // get a calendar row at its paid limit and no provider row at all.
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "pro",
          tier: "25k",
          status: "past_due",
          currentPeriodStart: new Date(Date.UTC(2025, 11, 1)),
          currentPeriodEnd: new Date(Date.UTC(2025, 11, 31)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("past_due_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      expect(await storedRows()).toHaveLength(0);
    });

    it("records an unlimited plan with no overage against its own limit", async () => {
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "enterprise",
          tier: null,
          status: "active",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("ent_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const [row] = await storedRows();
      expect(row?.plan).toBe("enterprise");
      expect(row?.executionLimit).toBe(-1);
      expect(row?.overageCount).toBe(0);
    });

    it("picks up a month an earlier run never recorded", async () => {
      // Closing only the month before `now` loses any month the scan did not
      // run across. The span walk has to catch it on the next run.
      await addNoSubRun("older_month", new Date(Date.UTC(2025, 11, 10)));
      await addNoSubRun("recent_month", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const rows = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(eq(executionUsagePeriods.organizationId, ORG_NOSUB));
      const starts = rows.map((r) => r.periodStart.toISOString()).sort();
      expect(starts).toContain(new Date(Date.UTC(2025, 11, 1)).toISOString());
      expect(starts).toContain(PERIOD_START.toISOString());
    });

    it.each(["billed", "pending", "failed"])(
      "stays out of a cycle held only by a %s overage record",
      async (status) => {
        // The cycle closed before this table recorded anything and the period
        // columns are empty, so the overage record is the only trace of it. It
        // has to count as coverage whatever its status: the window is the
        // billing path's as soon as the record exists.
        const cycleStart = new Date(Date.UTC(2025, 11, 10));
        const cycleEnd = new Date(Date.UTC(2026, 0, 10));
        await addOverageRecord(cycleStart, cycleEnd, status);
        await testDb
          .update(organizationSubscriptions)
          .set({
            plan: "pro",
            tier: "25k",
            status: "active",
            currentPeriodStart: null,
            currentPeriodEnd: null,
          })
          .where(eq(organizationSubscriptions.organizationId, ORG));
        await addRun("before_cycle", new Date(Date.UTC(2025, 11, 5)));
        await addRun("in_cycle_dec", new Date(Date.UTC(2025, 11, 20)));
        await addRun("in_cycle_jan", new Date(Date.UTC(2026, 0, 5)));
        await addRun("after_cycle", new Date(Date.UTC(2026, 0, 20)));

        const { closeCalendarMonthUsage } = await import(
          "../../lib/billing/execution-usage-periods"
        );
        await closeCalendarMonthUsage(AFTER_MONTH);

        const rows = await storedRows();
        expect(overlapping(rows, cycleStart, cycleEnd)).toHaveLength(0);

        // The days before the cycle belong to nobody else, so they are still
        // written, clipped at the cycle's start. The days after it are the
        // billing path's: the plan bills overage and they do not predate it.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.source).toBe("calendar_month");
        expect(rows[0]?.periodStart.toISOString()).toBe(
          new Date(Date.UTC(2025, 11, 1)).toISOString()
        );
        expect(rows[0]?.periodEnd.toISOString()).toBe(cycleStart.toISOString());
        expect(rows[0]?.totalExecutions).toBe(1);
        expect(rows[0]?.totalChargeCents).toBe(0);
      }
    );

    it("does not treat a later live cycle as the first one when an earlier one was billed", async () => {
      // A billed cycle, then a cycle nothing recorded, then the live one. The
      // live period alone makes every earlier month look pre-conversion.
      const billedStart = new Date(Date.UTC(2025, 10, 6));
      const billedEnd = new Date(Date.UTC(2025, 11, 6));
      await addOverageRecord(billedStart, billedEnd);
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "pro",
          tier: "25k",
          status: "active",
          currentPeriodStart: new Date(Date.UTC(2026, 0, 6)),
          currentPeriodEnd: new Date(Date.UTC(2026, 1, 6)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("pre_billed", new Date(Date.UTC(2025, 10, 3)));
      await addRun("in_billed", new Date(Date.UTC(2025, 10, 20)));
      await addRun("between_cycles", new Date(Date.UTC(2025, 11, 20)));
      await addRun("pre_live", new Date(Date.UTC(2026, 0, 3)));

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const rows = await storedRows();
      expect(overlapping(rows, billedStart, billedEnd)).toHaveLength(0);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.periodStart.toISOString()).toBe(
        new Date(Date.UTC(2025, 10, 1)).toISOString()
      );
      expect(rows[0]?.periodEnd.toISOString()).toBe(billedStart.toISOString());
      expect(rows[0]?.totalExecutions).toBe(1);
    });

    it.each([
      [
        "an overage record",
        (start: Date, end: Date) => addOverageRecord(start, end),
      ],
      [
        "a subscription row",
        (start: Date, end: Date) =>
          addUsageRow("old_cycle", start, end, "subscription"),
      ],
    ])(
      "records the days before a new live cycle when the last one, known from %s, is long past",
      async (_source, addOldCycle) => {
        // Paid in 2025, left, and subscribed again partway through a month in
        // the span. The old cycle says nothing about the gap after it: the
        // organization spent it on the free plan. Taking that cycle as the
        // start of paying would drop the days before the new one, and nothing
        // else writes them.
        await addOldCycle(
          new Date(Date.UTC(2025, 7, 6)),
          new Date(Date.UTC(2025, 8, 6))
        );
        const liveStart = new Date(Date.UTC(2026, 0, 6));
        await testDb
          .update(organizationSubscriptions)
          .set({
            plan: "pro",
            tier: "25k",
            status: "active",
            currentPeriodStart: liveStart,
            currentPeriodEnd: new Date(Date.UTC(2026, 1, 6)),
          })
          .where(eq(organizationSubscriptions.organizationId, ORG));
        await addRun("before_live", new Date(Date.UTC(2026, 0, 3)));
        await addRun("in_live", new Date(Date.UTC(2026, 0, 20)));

        const { closeCalendarMonthUsage } = await import(
          "../../lib/billing/execution-usage-periods"
        );
        await closeCalendarMonthUsage(AFTER_MONTH);

        const calendar = (await storedRows()).filter(
          (r) => r.source === "calendar_month"
        );
        expect(calendar).toHaveLength(1);
        expect(calendar[0]?.periodStart.toISOString()).toBe(
          PERIOD_START.toISOString()
        );
        expect(calendar[0]?.periodEnd.toISOString()).toBe(
          liveStart.toISOString()
        );
        expect(calendar[0]?.totalExecutions).toBe(1);
      }
    );

    it("finds the uncovered days after two adjacent cycles read later-first", async () => {
      // Coverage is three reads joined end to end, so the later cycle can come
      // first: here it is a recorded row, and the earlier one is an overage
      // record, which is read last. Walked in that order the month used to
      // read as fully covered and the days after the second cycle were lost.
      const boundary = new Date(Date.UTC(2025, 11, 10));
      const laterEnd = new Date(Date.UTC(2025, 11, 20));
      await addOverageRecord(new Date(Date.UTC(2025, 10, 10)), boundary);
      await addUsageRow("later_cycle", boundary, laterEnd, "subscription");
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan: "free",
          tier: null,
          status: "canceled",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("in_later_cycle", new Date(Date.UTC(2025, 11, 15)));
      await addRun("after_cycles", new Date(Date.UTC(2025, 11, 25)));

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const calendar = (await storedRows()).filter(
        (r) => r.source === "calendar_month"
      );
      expect(calendar).toHaveLength(1);
      expect(calendar[0]?.periodStart.toISOString()).toBe(
        laterEnd.toISOString()
      );
      expect(calendar[0]?.periodEnd.toISOString()).toBe(
        PERIOD_START.toISOString()
      );
      expect(calendar[0]?.totalExecutions).toBe(1);
    });
  });

  describe("repairCalendarRowsOverBilledCycles", () => {
    // Deliberately far older than CALENDAR_CLOSE_LOOKBACK_MONTHS from any date
    // the close is run with in this file, so nothing here can be put right by
    // the close itself.
    const CYCLE_START = new Date(Date.UTC(2025, 5, 10));
    const CYCLE_END = new Date(Date.UTC(2025, 6, 10));
    const JUNE = new Date(Date.UTC(2025, 5, 1));
    const JULY = new Date(Date.UTC(2025, 6, 1));
    const AUGUST = new Date(Date.UTC(2025, 7, 1));

    async function setPlan(plan: "pro" | "free"): Promise<void> {
      await testDb
        .update(organizationSubscriptions)
        .set({
          plan,
          tier: plan === "pro" ? "25k" : null,
          status: plan === "pro" ? "active" : "canceled",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
    }

    /**
     * The shape the old close left behind: a billed cycle from Jun 10 to
     * Jul 10 with a whole-month row written across each side of it.
     */
    async function seedRowsAcrossBilledCycle(): Promise<void> {
      await addOverageRecord(CYCLE_START, CYCLE_END);
      await addUsageRow("june", JUNE, JULY, "calendar_month", 2);
      await addUsageRow("july", JULY, AUGUST, "calendar_month", 2);
      await addRun("before_cycle", new Date(Date.UTC(2025, 5, 5)));
      await addRun("in_cycle_june", new Date(Date.UTC(2025, 5, 20)));
      await addRun("in_cycle_july", new Date(Date.UTC(2025, 6, 5)));
      await addRun("after_cycle", new Date(Date.UTC(2025, 6, 20)));
    }

    async function repair(dryRun = false) {
      const { repairCalendarRowsOverBilledCycles } = await import(
        "../../lib/billing/execution-usage-period-repair"
      );
      return await repairCalendarRowsOverBilledCycles({
        organizationId: ORG,
        dryRun,
      });
    }

    it.each([
      ["billed", 1000],
      ["pending", 0],
      ["failed", 0],
    ])(
      "records a cycle held only by a %s overage record from its frozen figures",
      async (status, expectedChargeCents) => {
        await setPlan("pro");
        await addOverageRecord(CYCLE_START, CYCLE_END, status);
        await addRun("in_cycle", new Date(Date.UTC(2025, 5, 20)));

        const summary = await repair();

        expect(summary.cyclesRecorded).toHaveLength(1);
        const rows = await storedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.source).toBe("subscription");
        expect(rows[0]?.periodStart.toISOString()).toBe(
          CYCLE_START.toISOString()
        );
        expect(rows[0]?.periodEnd.toISOString()).toBe(CYCLE_END.toISOString());
        // The limit, total and overage count are the record's, not a recount:
        // one run exists in the window and the limit is read off the record.
        expect(rows[0]?.executionLimit).toBe(25_000);
        expect(rows[0]?.totalExecutions).toBe(30_000);
        expect(rows[0]?.overageCount).toBe(5000);
        expect(rows[0]?.workflowExecutions).toBe(1);
        // Only a record that reached `billed` raised a charge.
        expect(rows[0]?.totalChargeCents).toBe(expectedChargeCents);
      }
    );

    it("rewrites a row older than the close lookback down to the days before the cycle", async () => {
      await setPlan("pro");
      await seedRowsAcrossBilledCycle();

      const summary = await repair();

      const rows = await storedRows();
      const calendar = rows.filter((r) => r.source === "calendar_month");
      expect(overlapping(calendar, CYCLE_START, CYCLE_END)).toHaveLength(0);
      // June keeps the days before the cycle, recounted for that window. July
      // keeps nothing: the plan bills overage and the days after the cycle do
      // not predate it, so they are the billing path's.
      expect(calendar).toHaveLength(1);
      expect(calendar[0]?.periodStart.toISOString()).toBe(JUNE.toISOString());
      expect(calendar[0]?.periodEnd.toISOString()).toBe(
        CYCLE_START.toISOString()
      );
      expect(calendar[0]?.totalExecutions).toBe(1);
      expect(calendar[0]?.totalChargeCents).toBe(0);
      expect(rows.filter((r) => r.source === "subscription")).toHaveLength(1);

      expect(summary.rowsRewritten).toHaveLength(2);
      expect(summary.rowsRewritten[0]?.written?.periodEnd.toISOString()).toBe(
        CYCLE_START.toISOString()
      );
      expect(summary.rowsRewritten[1]?.written).toBeNull();
    });

    it("also writes the days after the cycle for an organization that no longer bills overage", async () => {
      await setPlan("free");
      await seedRowsAcrossBilledCycle();

      await repair();

      const calendar = (await storedRows())
        .filter((r) => r.source === "calendar_month")
        .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
      expect(overlapping(calendar, CYCLE_START, CYCLE_END)).toHaveLength(0);
      expect(calendar).toHaveLength(2);
      expect(calendar[1]?.periodStart.toISOString()).toBe(
        CYCLE_END.toISOString()
      );
      expect(calendar[1]?.periodEnd.toISOString()).toBe(AUGUST.toISOString());
      expect(calendar[1]?.totalExecutions).toBe(1);
      expect(calendar[1]?.plan).toBe("free");
    });

    it("matches a row that crosses a cycle boundary and not one that only touches it", async () => {
      await setPlan("pro");
      await addOverageRecord(CYCLE_START, CYCLE_END);
      // Both windows are half-open. These two share an instant with the cycle
      // and no time: the first is exactly what the close writes for the days
      // before a cycle.
      await addUsageRow("ends_at_start", JUNE, CYCLE_START, "calendar_month");
      await addUsageRow("starts_at_end", CYCLE_END, AUGUST, "calendar_month");
      // One millisecond into the cycle from either side.
      await addUsageRow(
        "crosses_start",
        JUNE,
        new Date(CYCLE_START.getTime() + 1),
        "calendar_month"
      );
      await addUsageRow(
        "crosses_end",
        new Date(CYCLE_END.getTime() - 1),
        AUGUST,
        "calendar_month"
      );
      // A recorded cycle is never a candidate, wherever it lies.
      await addUsageRow("recorded", CYCLE_START, CYCLE_END, "subscription");

      const { findCalendarRowsOverBilledCycles } = await import(
        "../../lib/billing/execution-usage-period-repair"
      );
      const matched = await findCalendarRowsOverBilledCycles(ORG);

      expect(matched.map((r) => r.id).sort()).toEqual([
        `${PREFIX}crosses_end`,
        `${PREFIX}crosses_start`,
      ]);
    });

    it("leaves rows that only touch a cycle exactly as they are", async () => {
      await setPlan("pro");
      await addOverageRecord(CYCLE_START, CYCLE_END);
      await addUsageRow("ends_at_start", JUNE, CYCLE_START, "calendar_month");
      await addUsageRow("starts_at_end", CYCLE_END, AUGUST, "calendar_month");

      const summary = await repair();

      expect(summary.rowsRewritten).toHaveLength(0);
      const calendar = (await storedRows()).filter(
        (r) => r.source === "calendar_month"
      );
      expect(calendar.map((r) => r.id).sort()).toEqual([
        `${PREFIX}ends_at_start`,
        `${PREFIX}starts_at_end`,
      ]);
    });

    it("leaves a cycle's own record alone when it is labelled calendar_month", async () => {
      // billOverageForOrg labels the usage record `calendar_month` when the
      // subscription has no period columns as it runs. The row has the
      // record's exact window, so an overlap test alone would delete the only
      // record of the cycle.
      await setPlan("pro");
      await addOverageRecord(CYCLE_START, CYCLE_END, "pending");
      await addUsageRow("own_record", CYCLE_START, CYCLE_END, "calendar_month");

      const summary = await repair();

      expect(summary.cyclesRecorded).toHaveLength(0);
      expect(summary.rowsRewritten).toHaveLength(0);
      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(`${PREFIX}own_record`);
      expect(rows[0]?.source).toBe("calendar_month");
    });

    it("changes nothing on a second run", async () => {
      await setPlan("pro");
      await seedRowsAcrossBilledCycle();

      await repair();
      const afterFirst = await storedRowsById();
      const second = await repair();

      expect(second.cyclesRecorded).toHaveLength(0);
      expect(second.rowsRewritten).toHaveLength(0);
      expect(await storedRowsById()).toEqual(afterFirst);
    });

    it("reports a dry run and writes nothing", async () => {
      await setPlan("pro");
      await seedRowsAcrossBilledCycle();
      const before = await storedRowsById();

      const summary = await repair(true);

      expect(summary.cyclesRecorded).toHaveLength(1);
      expect(summary.rowsRewritten).toHaveLength(2);
      expect(await storedRowsById()).toEqual(before);
    });

    it("leaves the close nothing to add or undo", async () => {
      // The same shape inside the span the close looks at. The repair and the
      // close decide a window through the same function, so a close that runs
      // after the repair must find every row it would write already there.
      const cycleStart = new Date(Date.UTC(2025, 11, 10));
      const cycleEnd = new Date(Date.UTC(2026, 0, 10));
      await setPlan("pro");
      await addOverageRecord(cycleStart, cycleEnd);
      await addUsageRow(
        "december",
        new Date(Date.UTC(2025, 11, 1)),
        PERIOD_START,
        "calendar_month",
        2
      );
      await addUsageRow(
        "january",
        PERIOD_START,
        PERIOD_END,
        "calendar_month",
        2
      );
      await addRun("before_cycle", new Date(Date.UTC(2025, 11, 5)));
      await addRun("in_cycle_dec", new Date(Date.UTC(2025, 11, 20)));
      await addRun("in_cycle_jan", new Date(Date.UTC(2026, 0, 5)));
      await addRun("after_cycle", new Date(Date.UTC(2026, 0, 20)));

      await repair();
      const afterRepair = await storedRowsById();
      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(new Date(Date.UTC(2026, 1, 5)));

      expect(await storedRowsById()).toEqual(afterRepair);
      const calendar = afterRepair.filter((r) => r.source === "calendar_month");
      expect(calendar).toHaveLength(1);
      expect(calendar[0]?.periodEnd.toISOString()).toBe(
        cycleStart.toISOString()
      );
    });
  });
});
