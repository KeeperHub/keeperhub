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
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  directExecutions,
  executionUsagePeriods,
  organization,
  organizationSubscriptions,
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
  }
  // closeCalendarMonthUsage writes for every organization that ran in the
  // window, so a shared database can pick up rows for organizations this file
  // never seeded. The period is synthetic, so anything keyed to it is ours.
  await testDb
    .delete(executionUsagePeriods)
    .where(eq(executionUsagePeriods.periodStart, PERIOD_START));
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
        .where(eq(executionUsagePeriods.organizationId, ORG_NOSUB));

      expect(row?.workflowExecutions).toBe(1);
      expect(row?.directExecutions).toBe(1);
      expect(row?.totalExecutions).toBe(2);
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
      // subscription.deleted sets plan free and status canceled but never
      // clears the period columns, so a churned organization keeps its last
      // period on the row for good. Treating that as "on a cycle" excluded it
      // from the month close permanently while it kept running on the free
      // plan. Measured on production before the fix: 2,323 executions across
      // two organizations were queued to be lost at the next close.
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

      const [row] = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(eq(executionUsagePeriods.organizationId, ORG));

      expect(row).toBeDefined();
      expect(row?.source).toBe("calendar_month");
      expect(row?.totalExecutions).toBe(1);

      await testDb
        .update(organizationSubscriptions)
        .set({ currentPeriodStart: null, currentPeriodEnd: null })
        .where(eq(organizationSubscriptions.organizationId, ORG));
    });

    it("leaves an organization billed on a provider cycle to the billing path", async () => {
      // ORG carries a subscription with a provider period, so the calendar
      // sweep must not write a month row for it -- its record comes from
      // billOverageForOrg when that cycle closes.
      // A live, still-cycling period: its end is in the future relative to the
      // close, so another cycle record is still coming and the month close must
      // stay out of the way.
      await testDb
        .update(organizationSubscriptions)
        .set({
          currentPeriodStart: PERIOD_START,
          currentPeriodEnd: new Date(Date.UTC(2026, 2, 1)),
        })
        .where(eq(organizationSubscriptions.organizationId, ORG));
      await addRun("cycle_run", INSIDE);

      const { closeCalendarMonthUsage } = await import(
        "../../lib/billing/execution-usage-periods"
      );
      await closeCalendarMonthUsage(AFTER_MONTH);

      const rows = await testDb
        .select()
        .from(executionUsagePeriods)
        .where(eq(executionUsagePeriods.organizationId, ORG));
      expect(rows).toHaveLength(0);

      await testDb
        .update(organizationSubscriptions)
        .set({ currentPeriodStart: null, currentPeriodEnd: null })
        .where(eq(organizationSubscriptions.organizationId, ORG));
    });
  });
});
