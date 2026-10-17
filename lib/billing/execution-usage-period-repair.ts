import "server-only";

import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { executionUsagePeriods, overageBillingRecords } from "@/lib/db/schema";
import {
  addMonthsUtc,
  CALENDAR_CLOSE_LOOKBACK_MONTHS,
  calendarUsageRow,
  calendarWindowToRecord,
  countExecutionsForPeriod,
  getProviderCoverage,
  getSubscriptionsByOrg,
  monthStartUtc,
  type PeriodWindow,
  planSnapshotFrom,
  recordClosedPeriodUsage,
  type SubscriptionPlanRow,
} from "./execution-usage-periods";

export type UsagePeriodRepairOptions = {
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /** Restrict the run to one organization. */
  organizationId?: string;
};

/** A cycle that gained its `subscription` row from an overage record. */
export type RecordedCycle = PeriodWindow & {
  organizationId: string;
  totalExecutions: number;
  totalChargeCents: number;
};

/** A `calendar_month` row that ran across a billed cycle, and what replaced it. */
export type RewrittenCalendarRow = {
  organizationId: string;
  deleted: PeriodWindow & { totalExecutions: number };
  /** Null when no part of the deleted window is this path's to record. */
  written: (PeriodWindow & { totalExecutions: number }) | null;
};

export type UsagePeriodRepairSummary = {
  cyclesRecorded: RecordedCycle[];
  rowsRewritten: RewrittenCalendarRow[];
};

type OverageOnlyCycle = PeriodWindow & {
  organizationId: string;
  executionLimit: number;
  totalExecutions: number;
  overageCount: number;
  totalChargeCents: number;
  status: string;
};

/**
 * Overage records whose cycle has no usage row on its exact window.
 *
 * Any usage row counts, whatever its source: the unique key on
 * (organization, period_start, period_end) allows one row per window, so a
 * window that already holds a row is recorded and cannot take another.
 */
async function findOverageOnlyCycles(
  organizationId?: string
): Promise<OverageOnlyCycle[]> {
  return await db
    .select({
      organizationId: overageBillingRecords.organizationId,
      periodStart: overageBillingRecords.periodStart,
      periodEnd: overageBillingRecords.periodEnd,
      executionLimit: overageBillingRecords.executionLimit,
      totalExecutions: overageBillingRecords.totalExecutions,
      overageCount: overageBillingRecords.overageCount,
      totalChargeCents: overageBillingRecords.totalChargeCents,
      status: overageBillingRecords.status,
    })
    .from(overageBillingRecords)
    .leftJoin(
      executionUsagePeriods,
      and(
        eq(
          executionUsagePeriods.organizationId,
          overageBillingRecords.organizationId
        ),
        eq(
          executionUsagePeriods.periodStart,
          overageBillingRecords.periodStart
        ),
        eq(executionUsagePeriods.periodEnd, overageBillingRecords.periodEnd)
      )
    )
    .where(
      and(
        isNull(executionUsagePeriods.id),
        organizationId
          ? eq(overageBillingRecords.organizationId, organizationId)
          : undefined
      )
    )
    .orderBy(
      overageBillingRecords.organizationId,
      overageBillingRecords.periodStart
    );
}

export type CalendarRowOverBilledCycle = PeriodWindow & {
  id: string;
  organizationId: string;
  totalExecutions: number;
};

/**
 * `calendar_month` rows that run across a cycle held in
 * `overage_billing_records`.
 *
 * Both windows are half-open, so a row that ends on the instant a cycle starts
 * does not overlap it. That shape is exactly what the close writes for the
 * days before a cycle, and matching it would delete good rows on every run.
 *
 * A row on the exact window of a record is left out. It is that cycle's own
 * usage record: `billOverageForOrg` labels it `calendar_month` when the
 * subscription carries no period columns at the time it runs.
 */
export async function findCalendarRowsOverBilledCycles(
  organizationId?: string
): Promise<CalendarRowOverBilledCycle[]> {
  const pairs = await db
    .select({
      id: executionUsagePeriods.id,
      organizationId: executionUsagePeriods.organizationId,
      periodStart: executionUsagePeriods.periodStart,
      periodEnd: executionUsagePeriods.periodEnd,
      totalExecutions: executionUsagePeriods.totalExecutions,
      cycleStart: overageBillingRecords.periodStart,
      cycleEnd: overageBillingRecords.periodEnd,
    })
    .from(executionUsagePeriods)
    .innerJoin(
      overageBillingRecords,
      and(
        eq(
          overageBillingRecords.organizationId,
          executionUsagePeriods.organizationId
        ),
        lt(executionUsagePeriods.periodStart, overageBillingRecords.periodEnd),
        lt(overageBillingRecords.periodStart, executionUsagePeriods.periodEnd)
      )
    )
    .where(
      and(
        eq(executionUsagePeriods.source, "calendar_month"),
        organizationId
          ? eq(executionUsagePeriods.organizationId, organizationId)
          : undefined
      )
    )
    .orderBy(
      executionUsagePeriods.organizationId,
      executionUsagePeriods.periodStart
    );

  const rows = new Map<string, CalendarRowOverBilledCycle>();
  const cycleOwnRecords = new Set<string>();
  for (const pair of pairs) {
    if (
      pair.periodStart.getTime() === pair.cycleStart.getTime() &&
      pair.periodEnd.getTime() === pair.cycleEnd.getTime()
    ) {
      cycleOwnRecords.add(pair.id);
    }
    rows.set(pair.id, {
      id: pair.id,
      organizationId: pair.organizationId,
      periodStart: pair.periodStart,
      periodEnd: pair.periodEnd,
      totalExecutions: pair.totalExecutions,
    });
  }
  return [...rows.values()].filter((row) => !cycleOwnRecords.has(row.id));
}

async function recordOverageOnlyCycle(
  cycle: OverageOnlyCycle,
  sub: SubscriptionPlanRow | undefined,
  dryRun: boolean
): Promise<RecordedCycle> {
  // A record that never reached `billed` raised no charge, so the row must not
  // claim one. The limit, total and overage count are what the cycle closed
  // on whatever became of the charge.
  const totalChargeCents =
    cycle.status === "billed" ? cycle.totalChargeCents : 0;

  if (!dryRun) {
    // Plan name and tier are today's: the record does not store them. The
    // limit is the record's own, as in the backfill, so the row agrees with
    // what the charge was raised on.
    const { plan, tier } = planSnapshotFrom(sub);
    await recordClosedPeriodUsage({
      organizationId: cycle.organizationId,
      periodStart: cycle.periodStart,
      periodEnd: cycle.periodEnd,
      source: "subscription",
      planSnapshot: { plan, tier, executionLimit: cycle.executionLimit },
      counts: await countExecutionsForPeriod(
        cycle.organizationId,
        cycle.periodStart,
        cycle.periodEnd
      ),
      billedTotalExecutions: cycle.totalExecutions,
      billedOverageCount: cycle.overageCount,
      totalChargeCents,
      // The billing path wrote this record, which is itself the statement
      // that the cycle closed. See the same flag in `billOverageForOrg`.
      periodEndedEarly: true,
    });
  }

  return {
    organizationId: cycle.organizationId,
    periodStart: cycle.periodStart,
    periodEnd: cycle.periodEnd,
    totalExecutions: cycle.totalExecutions,
    totalChargeCents,
  };
}

async function rewriteCalendarRow(
  row: CalendarRowOverBilledCycle,
  sub: SubscriptionPlanRow | undefined,
  dryRun: boolean
): Promise<RewrittenCalendarRow> {
  // The span the close itself reads when the row's month is the newest one it
  // closes. A wider span would judge the row on cycles the close never saw.
  const spanEnd = addMonthsUtc(
    monthStartUtc(new Date(row.periodEnd.getTime() - 1)),
    1
  );
  const spanStart = addMonthsUtc(
    monthStartUtc(row.periodStart),
    1 - CALENDAR_CLOSE_LOOKBACK_MONTHS
  );
  const coverage = await getProviderCoverage(
    [row.organizationId],
    spanStart,
    spanEnd
  );
  const window = calendarWindowToRecord(
    row.periodStart,
    row.periodEnd,
    coverage.get(row.organizationId) ?? [],
    sub
  );
  const counts =
    window === null
      ? null
      : await countExecutionsForPeriod(
          row.organizationId,
          window.periodStart,
          window.periodEnd
        );
  // The close writes no row for a window with no executions.
  const replacement =
    window !== null && counts !== null && counts.total > 0
      ? calendarUsageRow(row.organizationId, window, counts, sub)
      : null;

  if (!dryRun) {
    // One transaction, so a failure leaves the original row and never a gap.
    await db.transaction(async (tx) => {
      await tx
        .delete(executionUsagePeriods)
        .where(eq(executionUsagePeriods.id, row.id));
      if (replacement !== null) {
        await tx
          .insert(executionUsagePeriods)
          .values(replacement)
          .onConflictDoNothing();
      }
    });
  }

  return {
    organizationId: row.organizationId,
    deleted: {
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      totalExecutions: row.totalExecutions,
    },
    written:
      replacement === null
        ? null
        : {
            periodStart: replacement.periodStart,
            periodEnd: replacement.periodEnd,
            totalExecutions: replacement.totalExecutions,
          },
  };
}

/**
 * Repair the usage rows the calendar-month close wrote across cycles it did
 * not know about.
 *
 * The close used to miss any cycle held only in `overage_billing_records`, and
 * wrote whole-month rows across it. Two steps put that right:
 *
 * 1. Every such cycle gets its `subscription` row, from the figures the record
 *    froze. The cycle is then on record in `execution_usage_periods` like any
 *    other.
 * 2. Every `calendar_month` row that overlaps a record is deleted and the part
 *    of it the close would write is put back, recounted for the clipped
 *    window. The close cannot do this itself: it only looks back
 *    `CALENDAR_CLOSE_LOOKBACK_MONTHS`, so an older row would be gone for good.
 *
 * Runs after the fixed close is serving. An older close still running beside
 * it does not read overage records and would write the same rows again.
 *
 * Idempotent: a second run finds no cycle without a row and no overlap.
 */
export async function repairCalendarRowsOverBilledCycles(
  options: UsagePeriodRepairOptions = {}
): Promise<UsagePeriodRepairSummary> {
  const dryRun = options.dryRun ?? false;
  const [cycles, rows] = await Promise.all([
    findOverageOnlyCycles(options.organizationId),
    findCalendarRowsOverBilledCycles(options.organizationId),
  ]);
  const subscriptions = await getSubscriptionsByOrg([
    ...new Set([...cycles, ...rows].map((entry) => entry.organizationId)),
  ]);

  const cyclesRecorded: RecordedCycle[] = [];
  for (const cycle of cycles) {
    cyclesRecorded.push(
      await recordOverageOnlyCycle(
        cycle,
        subscriptions.get(cycle.organizationId),
        dryRun
      )
    );
  }

  const rowsRewritten: RewrittenCalendarRow[] = [];
  for (const row of rows) {
    rowsRewritten.push(
      await rewriteCalendarRow(
        row,
        subscriptions.get(row.organizationId),
        dryRun
      )
    );
  }

  return { cyclesRecorded, rowsRewritten };
}
