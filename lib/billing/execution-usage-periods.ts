import "server-only";

import { and, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type ExecutionUsagePeriodSource,
  executionUsagePeriods,
  organizationSubscriptions,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { startOfCurrentMonthUtc } from "./execution-limit-core";
import {
  billsOverage,
  getPlanLimits,
  type PlanLimits,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "./plans";
import { getOrgSubscription } from "./subscription-read";

export type PeriodWindow = {
  periodStart: Date;
  periodEnd: Date;
};

export type PeriodExecutionCounts = {
  /** Billable `workflow_executions` rows started inside the period. */
  workflowExecutions: number;
  /** `direct_executions` rows created inside the period. */
  directExecutions: number;
  /** What the period was billed on: the two halves summed. */
  total: number;
};

/**
 * Count an organization's billable executions inside one period, keeping the
 * workflow and direct halves apart.
 *
 * This is the one place the billing count is expressed. `lib/billing/overage.ts`
 * and `lib/billing/execution-usage.ts` both used to carry their own copy of the
 * same SQL, and the two had to agree for an invoice to reconcile with the charge
 * raised against it.
 *
 * The organization comes from `workflows.organization_id`, not the denormalized
 * `workflow_executions.organization_id`: that column is still NULL on the
 * majority of production rows because its backfill never ran.
 */
export async function countExecutionsForPeriod(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<PeriodExecutionCounts> {
  const rows = await db.execute<{
    workflow_executions: number;
    direct_executions: number;
  }>(
    sql`SELECT
          (
            SELECT COUNT(*)::int
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${periodStart.toISOString()}
               AND we.started_at <  ${periodEnd.toISOString()}
               AND we.billable = TRUE
          ) AS workflow_executions,
          (
            SELECT COUNT(*)::int
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${periodStart.toISOString()}
               AND de.created_at <  ${periodEnd.toISOString()}
          ) AS direct_executions`
  );

  const workflowExecutions = rows[0]?.workflow_executions ?? 0;
  const directExecutions = rows[0]?.direct_executions ?? 0;
  return {
    workflowExecutions,
    directExecutions,
    total: workflowExecutions + directExecutions,
  };
}

/** One organization's execution halves inside one calendar month. */
export type OrgMonthExecutionCounts = PeriodExecutionCounts & {
  organizationId: string;
  monthStart: Date;
};

/**
 * How far back the month close will look for a month it never recorded.
 *
 * Closing only the month before `now` loses any month the scan did not run
 * across, and any month whose insert failed: the next run has already moved
 * on, and once retention removes the execution rows the figure cannot be
 * rebuilt. Walking back a bounded number of months closes that gap without
 * re-scanning the whole table on every run. Deeper history is the backfill's
 * job, not this pass's.
 */
export const CALENDAR_CLOSE_LOOKBACK_MONTHS = 3;

/** First instant of the UTC month `date` falls in. */
export function monthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** `date` shifted by whole UTC months. */
export function addMonthsUtc(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
}

/**
 * Execution counts per organization per calendar month across a span, as one
 * aggregate.
 *
 * Same shape as `countExecutionsByOrgForPeriod`, grouped by month as well as
 * organization so a single read covers every month the close might still owe a
 * record for.
 */
export async function countExecutionsByOrgMonthForSpan(
  spanStart: Date,
  spanEnd: Date
): Promise<OrgMonthExecutionCounts[]> {
  const from = spanStart.toISOString();
  const to = spanEnd.toISOString();

  const rows = await db.execute<{
    organization_id: string;
    month_start: string;
    workflow_executions: number;
    direct_executions: number;
  }>(
    sql`SELECT org_id AS organization_id,
               month_start,
               SUM(workflow_subtotal)::int AS workflow_executions,
               SUM(direct_subtotal)::int   AS direct_executions
          FROM (
            SELECT w.organization_id AS org_id,
                   to_char(date_trunc('month', we.started_at), 'YYYY-MM-DD') AS month_start,
                   COUNT(*)::int AS workflow_subtotal,
                   0             AS direct_subtotal
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE we.started_at >= ${from}
               AND we.started_at <  ${to}
               AND we.billable = TRUE
             GROUP BY w.organization_id, date_trunc('month', we.started_at)
            UNION ALL
            SELECT de.organization_id AS org_id,
                   to_char(date_trunc('month', de.created_at), 'YYYY-MM-DD') AS month_start,
                   0             AS workflow_subtotal,
                   COUNT(*)::int AS direct_subtotal
              FROM direct_executions de
             WHERE de.created_at >= ${from}
               AND de.created_at <  ${to}
             GROUP BY de.organization_id, date_trunc('month', de.created_at)
          ) t
         GROUP BY org_id, month_start`
  );

  return rows.map((row) => ({
    organizationId: row.organization_id,
    // Rebuilt as UTC midnight on purpose: the aggregate returns a bare date,
    // and letting the runtime parse a naive timestamp would shift every month
    // boundary by the host's offset.
    monthStart: new Date(`${row.month_start}T00:00:00.000Z`),
    workflowExecutions: row.workflow_executions,
    directExecutions: row.direct_executions,
    total: row.workflow_executions + row.direct_executions,
  }));
}

/** One organization's two execution halves inside a period. */
export type OrgPeriodExecutionCounts = PeriodExecutionCounts & {
  organizationId: string;
};

/**
 * The same count as `countExecutionsForPeriod`, for every organization that ran
 * something in the period, as a single aggregate.
 *
 * Driving from the executions rather than from a list of organizations is what
 * makes the close scan correct as well as cheap. Most organizations have no
 * `organization_subscriptions` row at all -- on production about 1,090 of
 * 1,526 -- so any sweep that enumerates that table silently skips the majority
 * of the free plan, which is exactly who this record has to cover. An
 * organization appears here because it ran something, which is the only
 * condition that matters.
 *
 * Mirrors `countMonthlyExecutionsByOrg` in ./quota-threshold.ts, with the
 * window bounded on both sides (that one counts an open month from its start)
 * and the two halves kept apart rather than summed, because they are stored
 * apart: the run-row retention pass deletes only the workflow half, so a later
 * discrepancy is diagnosable instead of a single number that quietly shrinks.
 */
export async function countExecutionsByOrgForPeriod(
  periodStart: Date,
  periodEnd: Date
): Promise<OrgPeriodExecutionCounts[]> {
  const from = periodStart.toISOString();
  const to = periodEnd.toISOString();

  const rows = await db.execute<{
    organization_id: string;
    workflow_executions: number;
    direct_executions: number;
  }>(
    sql`SELECT org_id AS organization_id,
               SUM(workflow_subtotal)::int AS workflow_executions,
               SUM(direct_subtotal)::int   AS direct_executions
          FROM (
            SELECT w.organization_id AS org_id,
                   COUNT(*)::int AS workflow_subtotal,
                   0             AS direct_subtotal
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE we.started_at >= ${from}
               AND we.started_at <  ${to}
               AND we.billable = TRUE
             GROUP BY w.organization_id
            UNION ALL
            SELECT de.organization_id AS org_id,
                   0             AS workflow_subtotal,
                   COUNT(*)::int AS direct_subtotal
              FROM direct_executions de
             WHERE de.created_at >= ${from}
               AND de.created_at <  ${to}
             GROUP BY de.organization_id
          ) t
         GROUP BY org_id`
  );

  return rows.map((row) => ({
    organizationId: row.organization_id,
    workflowExecutions: row.workflow_executions,
    directExecutions: row.direct_executions,
    total: row.workflow_executions + row.direct_executions,
  }));
}

/** Plan facts as stored on a subscription row, before limits are resolved. */
export type SubscriptionPlanRow = {
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null;
  /**
   * The provider period, when the organization has one. Read by the close scan,
   * but note its presence alone decides nothing: the columns are never cleared,
   * so a churned organization still carries its last period. See
   * `isBilledOnCalendarMonth`.
   */
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

/**
 * Plan, tier and overrides for many organizations in one read.
 *
 * Deliberately not the same helper as the one in ./quota-threshold.ts: that one
 * serves the threshold scan and does not read the period columns, which the
 * month close needs in order to tell a live cycle from a stale one. Merging
 * them would widen a file that is currently carrying its own plan-resolution
 * fixes, for no gain here.
 *
 * An organization missing from the result has no subscription row. See
 * `planSnapshotFrom` for why that is unambiguous on this path.
 */
export async function getSubscriptionsByOrg(
  organizationIds: string[]
): Promise<Map<string, SubscriptionPlanRow>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      organizationId: organizationSubscriptions.organizationId,
      plan: organizationSubscriptions.plan,
      tier: organizationSubscriptions.tier,
      planOverrides: organizationSubscriptions.planOverrides,
      currentPeriodStart: organizationSubscriptions.currentPeriodStart,
      currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
    })
    .from(organizationSubscriptions)
    .where(inArray(organizationSubscriptions.organizationId, organizationIds));

  return new Map(
    rows.map((row) => [
      row.organizationId,
      {
        plan: parsePlanName(row.plan),
        tier: parseTierKey(row.tier),
        planOverrides: row.planOverrides ?? null,
        currentPeriodStart: row.currentPeriodStart,
        currentPeriodEnd: row.currentPeriodEnd,
      },
    ])
  );
}

/**
 * Resolve a subscription row (or its absence) to the plan facts we store.
 *
 * Absence is read as the free plan, which elsewhere is a real hazard:
 * `resolveOrgPlan` exists because a single-row read coming back empty is
 * indistinguishable from an organization that genuinely has no subscription,
 * and free is itself a plan with a limit. That ambiguity does not arise here.
 * The caller already knows the organization exists, because it appears in the
 * usage aggregate and therefore owns workflows, and the subscriptions are
 * fetched as one bounded `IN (...)` read that throws rather than silently
 * returning nothing. So a missing entry means no row, not a failed read.
 */
export function planSnapshotFrom(
  sub: SubscriptionPlanRow | undefined
): PlanSnapshot {
  const plan = sub?.plan ?? "free";
  const tier = sub?.tier ?? null;
  const limits = getPlanLimits(plan, tier, sub?.planOverrides ?? undefined);
  return { plan, tier, executionLimit: limits.maxExecutionsPerMonth };
}

/**
 * The period boundaries to snapshot for an organization, and how they were
 * derived.
 *
 * An organization with a Stripe subscription carries its own period. Every
 * other organization -- which on production is the large majority, all on the
 * free plan -- has none, so the UTC calendar month is used instead. That is the
 * same window `startOfCurrentMonthUtc` gives the live quota counters, so a
 * stored figure and a live one describe the same span.
 */
export function resolvePeriodSource(
  currentPeriodStart: Date | null | undefined,
  currentPeriodEnd: Date | null | undefined
): ExecutionUsagePeriodSource {
  return currentPeriodStart && currentPeriodEnd
    ? "subscription"
    : "calendar_month";
}

/**
 * Whether a window predates every provider cycle the organization has.
 *
 * This is the only plan history available. Nothing records what plan an
 * organization was on in a month that has closed, but a window lying entirely
 * before its earliest known cycle is necessarily before it started paying, so
 * the paid plan it is on now did not apply then. That is what makes the
 * pre-conversion part of a conversion month writable: the organization bills
 * overage today, but did not during those days, so a month row with no charge
 * is accurate rather than contradictory.
 */
export function predatesProviderCycles(
  window: PeriodWindow,
  covered: CoveredInterval[]
): boolean {
  if (covered.length === 0) {
    return false;
  }
  const earliest = covered.reduce(
    (min, c) => (c.start < min ? c.start : min),
    covered[0].start
  );
  return window.periodEnd <= earliest;
}

/** A half-open interval a provider cycle already accounts for. */
export type CoveredInterval = { start: Date; end: Date };

/**
 * The part of `[windowStart, windowEnd)` that no provider cycle covers.
 *
 * Deciding this per organization was wrong in both directions, and the plan as
 * of `now` cannot answer it for a month already closed. An organization churned
 * to free keeps its lapsed period columns, which is exactly the set
 * `handleScan` feeds to `billOverageForOrg`, so it gets a `subscription` row
 * over its provider window; writing whole calendar months across the same span
 * then double counts, and the unique key on
 * `(organization, period_start, period_end)` cannot see it because the windows
 * differ. In the other direction an organization that converts mid-month bills
 * overage by the time the close runs, so a plan-level gate drops every month in
 * the span for it, including the part of the conversion month before the
 * provider period starts, which nothing else records.
 *
 * So coverage decides, month by month. Returns null when the cycle covers the
 * window completely.
 */
export function uncoveredPart(
  windowStart: Date,
  windowEnd: Date,
  covered: CoveredInterval[]
): PeriodWindow | null {
  let start = windowStart;
  let end = windowEnd;
  for (const interval of covered) {
    if (interval.end <= start || interval.start >= end) {
      continue;
    }
    // Trim from whichever side the cycle overlaps. A cycle biting out the
    // middle would split the window in two; provider periods run contiguously
    // from the subscription onward, so in practice they clip an edge.
    if (interval.start <= start && interval.end >= end) {
      return null;
    }
    if (interval.start <= start) {
      start = interval.end;
    } else {
      end = interval.start;
    }
  }
  return start < end ? { periodStart: start, periodEnd: end } : null;
}

/** First instant of the UTC month before the one `now` falls in. */
export function previousCalendarMonth(now: Date = new Date()): PeriodWindow {
  const periodEnd = startOfCurrentMonthUtc(now);
  const periodStart = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, 1)
  );
  return { periodStart, periodEnd };
}

/** Plan facts a caller already holds, so this does not re-read the row. */
export type PlanSnapshot = {
  plan: PlanName;
  tier: TierKey | null;
  executionLimit: number;
};

type RecordPeriodInput = {
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
  source: ExecutionUsagePeriodSource;
  /** Counts already read by the caller, to avoid counting the period twice. */
  counts?: PeriodExecutionCounts;
  /** Plan facts already read by the caller, to avoid a second subscription read. */
  planSnapshot?: PlanSnapshot;
  /**
   * What was charged for the period, when the caller already knows it. The
   * live path learns the charge only after the provider accepts it and stamps
   * it separately; the backfill carries across a charge already recorded in
   * `overage_billing_records`, which would otherwise never be stamped because
   * that period is long past its billing call.
   */
  totalChargeCents?: number;
  /**
   * Treat the period as closed even though its end is still in the future.
   *
   * Set only when the subscription itself has ended: the period cannot gain
   * another billable execution, so the count is final and is exactly what the
   * closing charge was raised on. Without this the final period of a
   * cancellation would be billed and never recorded.
   */
  periodEndedEarly?: boolean;
  /**
   * The total and overage count a billed `overage_billing_records` row froze
   * for this period.
   *
   * Only the backfill sets these. Recomputing the overage from the limit and a
   * live count would restate what the invoice was actually raised on, which is
   * the contradiction this whole field set exists to avoid; the live halves
   * stay as counted so the row still says what is in the tables today.
   */
  billedTotalExecutions?: number;
  billedOverageCount?: number;
};

export type RecordPeriodResult =
  | { recorded: true; total: number }
  | { recorded: false; reason: "period still open" | "already recorded" };

/** Plan, tier and execution limit for an organization as they stand now. */
export async function readPlanSnapshot(
  organizationId: string
): Promise<PlanSnapshot> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);
  const limits = getPlanLimits(plan, tier, sub?.planOverrides);
  return { plan, tier, executionLimit: limits.maxExecutionsPerMonth };
}

/**
 * Freeze what a closed period was billed on.
 *
 * Idempotent through the unique key on (organization, period_start, period_end):
 * a second call for the same period writes nothing and reports `already
 * recorded`. An open period is refused outright -- storing a partial count as
 * the final figure is worse than having no row, because a later read would
 * trust it.
 *
 * `plan`, `tier` and `execution_limit` are taken from the subscription as it
 * stands when this runs. Writing at period close keeps that honest; a plan
 * changed later cannot rewrite the row, which is the whole point, but a plan
 * changed between the close and this call is recorded as the new one. The
 * period-close hooks make that window small. For history it reconstructs the
 * backfill does better wherever it can: a period with a billed
 * `overage_billing_records` row passes that row's own limit and totals in, so
 * the stored figures agree with the charge instead of being restated against
 * today's plan.
 */
export async function recordClosedPeriodUsage(
  input: RecordPeriodInput,
  now: Date = new Date()
): Promise<RecordPeriodResult> {
  const { organizationId, periodStart, periodEnd, source } = input;

  if (periodEnd > now && !input.periodEndedEarly) {
    return { recorded: false, reason: "period still open" };
  }

  const planSnapshot =
    input.planSnapshot ?? (await readPlanSnapshot(organizationId));

  const counts =
    input.counts ??
    (await countExecutionsForPeriod(organizationId, periodStart, periodEnd));

  const totalExecutions = input.billedTotalExecutions ?? counts.total;
  const overageCount =
    input.billedOverageCount ??
    (planSnapshot.executionLimit === -1
      ? 0
      : Math.max(0, counts.total - planSnapshot.executionLimit));

  const [row] = await db
    .insert(executionUsagePeriods)
    .values({
      organizationId,
      periodStart,
      periodEnd,
      plan: planSnapshot.plan,
      tier: planSnapshot.tier,
      executionLimit: planSnapshot.executionLimit,
      workflowExecutions: counts.workflowExecutions,
      directExecutions: counts.directExecutions,
      totalExecutions,
      overageCount,
      totalChargeCents: input.totalChargeCents ?? 0,
      source,
    })
    .onConflictDoNothing()
    .returning();

  return row
    ? { recorded: true, total: counts.total }
    : { recorded: false, reason: "already recorded" };
}

/**
 * Stamp what was actually charged for a period onto its usage record.
 *
 * The charge itself stays in `overage_billing_records`; this copy is what lets
 * the invoices page render a closed period without a second lookup.
 */
export async function stampPeriodCharge(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  totalChargeCents: number
): Promise<boolean> {
  const updated = await db
    .update(executionUsagePeriods)
    .set({ totalChargeCents })
    .where(
      and(
        eq(executionUsagePeriods.organizationId, organizationId),
        eq(executionUsagePeriods.periodStart, periodStart),
        eq(executionUsagePeriods.periodEnd, periodEnd)
      )
    )
    .returning({ id: executionUsagePeriods.id });
  return updated.length > 0;
}

/**
 * Which of `organizationIds` already have a record for exactly this period.
 *
 * Lets a repeat run of the close scan skip the counting entirely rather than
 * counting every organization again and discarding the result on conflict.
 */
export async function getRecordedOrganizationIds(
  organizationIds: string[],
  periodStart: Date,
  periodEnd: Date
): Promise<Set<string>> {
  if (organizationIds.length === 0) {
    return new Set();
  }

  const rows = await db
    .select({ organizationId: executionUsagePeriods.organizationId })
    .from(executionUsagePeriods)
    .where(
      and(
        inArray(executionUsagePeriods.organizationId, organizationIds),
        eq(executionUsagePeriods.periodStart, periodStart),
        eq(executionUsagePeriods.periodEnd, periodEnd)
      )
    );

  return new Set(rows.map((row) => row.organizationId));
}

/**
 * Which `(organization, period)` pairs already have a record inside a span.
 *
 * The month close needs this across several months at once, so it keys on the
 * pair rather than on the organization alone the way
 * `getRecordedOrganizationIds` does for a single period.
 */
export async function getRecordedPeriodKeys(
  organizationIds: string[],
  spanStart: Date,
  spanEnd: Date
): Promise<Set<string>> {
  if (organizationIds.length === 0) {
    return new Set();
  }

  const rows = await db
    .select({
      organizationId: executionUsagePeriods.organizationId,
      periodStart: executionUsagePeriods.periodStart,
      periodEnd: executionUsagePeriods.periodEnd,
    })
    .from(executionUsagePeriods)
    .where(
      and(
        inArray(executionUsagePeriods.organizationId, organizationIds),
        gte(executionUsagePeriods.periodStart, spanStart),
        lte(executionUsagePeriods.periodStart, spanEnd)
      )
    );

  return new Set(
    rows.map(
      (row) =>
        `${row.organizationId}|${periodKey(row.periodStart, row.periodEnd)}`
    )
  );
}

/**
 * The provider cycles that already account for usage inside a span.
 *
 * Two sources, because neither alone is complete. The `subscription` rows in
 * this table are the cycles actually recorded, which is what the close must
 * not duplicate. The live period columns cover the cycle currently open or
 * just closed, which `handleScan` is about to record but may not have yet, and
 * which is the exact window a churned organization keeps forever.
 */
export async function getProviderCoverage(
  organizationIds: string[],
  spanStart: Date,
  spanEnd: Date
): Promise<Map<string, CoveredInterval[]>> {
  if (organizationIds.length === 0) {
    return new Map();
  }

  const [recorded, subs] = await Promise.all([
    db
      .select({
        organizationId: executionUsagePeriods.organizationId,
        periodStart: executionUsagePeriods.periodStart,
        periodEnd: executionUsagePeriods.periodEnd,
      })
      .from(executionUsagePeriods)
      .where(
        and(
          inArray(executionUsagePeriods.organizationId, organizationIds),
          eq(executionUsagePeriods.source, "subscription"),
          lt(executionUsagePeriods.periodStart, spanEnd),
          gt(executionUsagePeriods.periodEnd, spanStart)
        )
      ),
    db
      .select({
        organizationId: organizationSubscriptions.organizationId,
        periodStart: organizationSubscriptions.currentPeriodStart,
        periodEnd: organizationSubscriptions.currentPeriodEnd,
      })
      .from(organizationSubscriptions)
      .where(
        inArray(organizationSubscriptions.organizationId, organizationIds)
      ),
  ]);

  const coverage = new Map<string, CoveredInterval[]>();
  const add = (orgId: string, start: Date, end: Date): void => {
    if (end <= spanStart || start >= spanEnd) {
      return;
    }
    const list = coverage.get(orgId) ?? [];
    list.push({ start, end });
    coverage.set(orgId, list);
  };

  for (const row of recorded) {
    add(row.organizationId, row.periodStart, row.periodEnd);
  }
  for (const row of subs) {
    if (row.periodStart !== null && row.periodEnd !== null) {
      add(row.organizationId, row.periodStart, row.periodEnd);
    }
  }
  return coverage;
}

export type StoredPeriodUsage = {
  periodStart: Date;
  periodEnd: Date;
  totalExecutions: number;
  executionLimit: number;
};

/**
 * Read the stored figure for each requested window, keyed by period so the
 * caller can tell a stored period from one that has never been recorded.
 *
 * One query for every window asked about, rather than one per window.
 */
export async function getStoredUsageForPeriods(
  organizationId: string,
  windows: PeriodWindow[]
): Promise<Map<string, StoredPeriodUsage>> {
  if (windows.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      periodStart: executionUsagePeriods.periodStart,
      periodEnd: executionUsagePeriods.periodEnd,
      totalExecutions: executionUsagePeriods.totalExecutions,
      executionLimit: executionUsagePeriods.executionLimit,
    })
    .from(executionUsagePeriods)
    .where(
      and(
        eq(executionUsagePeriods.organizationId, organizationId),
        inArray(
          executionUsagePeriods.periodStart,
          windows.map((w) => w.periodStart)
        )
      )
    );

  const stored = new Map<string, StoredPeriodUsage>();
  for (const row of rows) {
    stored.set(periodKey(row.periodStart, row.periodEnd), row);
  }
  return stored;
}

/** Stable key for a period, used to align stored rows to requested windows. */
export function periodKey(periodStart: Date, periodEnd: Date): string {
  return `${periodStart.toISOString()}:${periodEnd.toISOString()}`;
}

export type CalendarCloseSummary = {
  /** Oldest month the run considered. */
  spanStart: string;
  /** Exclusive end of the newest month the run considered. */
  spanEnd: string;
  /** Organization-months billed on the calendar that had usage in the span. */
  considered: number;
  /** Rows written by this run. */
  recorded: number;
  /** Already written by an earlier run, so skipped without counting again. */
  skipped: number;
  /** Rows in chunks that failed; the next run retries them. */
  failed: number;
};

/**
 * Rows per insert.
 *
 * Drizzle binds 13 parameters per row here, so one statement over every
 * pending organization would hit Postgres' 65535 parameter ceiling at 5,041
 * rows - around 3x the current population, which is not enough headroom to
 * rely on. Chunking also bounds the blast radius of a single bad row:
 * `onConflictDoNothing` covers the unique key but not the `organization_id`
 * foreign key, so an organization deleted between the aggregate and the insert
 * would otherwise abort every row in the month.
 */
const CALENDAR_CLOSE_INSERT_CHUNK = 500;

type PendingUsageRow = typeof executionUsagePeriods.$inferInsert;

/**
 * Freeze every closed calendar month an organization billed on the calendar
 * still owes a record for.
 *
 * An organization billed on a provider cycle is deliberately absent: its period
 * is not the calendar month and its record is written by `billOverageForOrg`
 * when that cycle closes. See `isBilledOnCalendarMonth` for why the plan, not
 * the period columns, decides that.
 *
 * Everyone else is covered here, and that is most of the product: an
 * organization with no `organization_subscriptions` row has no period boundary
 * anywhere, so without this pass its usage is never frozen.
 *
 * Three reads regardless of organization count - the usage aggregate, the
 * subscriptions, the records that already exist - then one insert per chunk.
 */
export async function closeCalendarMonthUsage(
  now: Date = new Date()
): Promise<CalendarCloseSummary> {
  const spanEnd = monthStartUtc(now);
  const spanStart = addMonthsUtc(spanEnd, -CALENDAR_CLOSE_LOOKBACK_MONTHS);
  const summary = (
    recorded: number,
    skipped: number,
    considered: number,
    failed: number
  ): CalendarCloseSummary => ({
    spanStart: spanStart.toISOString(),
    spanEnd: spanEnd.toISOString(),
    considered,
    recorded,
    skipped,
    failed,
  });

  const usage = await countExecutionsByOrgMonthForSpan(spanStart, spanEnd);
  if (usage.length === 0) {
    return summary(0, 0, 0, 0);
  }

  const organizationIds = [...new Set(usage.map((row) => row.organizationId))];
  const [subscriptions, coverage, recordedKeys] = await Promise.all([
    getSubscriptionsByOrg(organizationIds),
    getProviderCoverage(organizationIds, spanStart, spanEnd),
    getRecordedPeriodKeys(organizationIds, spanStart, spanEnd),
  ]);

  const values: PendingUsageRow[] = [];
  let considered = 0;
  let skipped = 0;

  for (const row of usage) {
    const monthStart = row.monthStart;
    const monthEnd = addMonthsUtc(monthStart, 1);
    const window = uncoveredPart(
      monthStart,
      monthEnd,
      coverage.get(row.organizationId) ?? []
    );
    // Fully covered by a provider cycle: that cycle's own record is the one
    // that counts, and a month row beside it would double count.
    if (window === null) {
      continue;
    }
    // Coverage says nobody billed this window. The plan still decides whether
    // a zero-charge month row is an honest thing to write for it: a plan that
    // bills overage settles through its cycle, so a month row beside a stalled
    // or dunning cycle would carry the paid limit and a charge of zero. The
    // exception is a window predating every cycle the organization has, which
    // is the part of a conversion month before it started paying.
    const sub = subscriptions.get(row.organizationId);
    const covers = coverage.get(row.organizationId) ?? [];
    if (
      sub !== undefined &&
      billsOverage(sub.plan) &&
      !predatesProviderCycles(window, covers)
    ) {
      continue;
    }
    considered += 1;

    const key = `${row.organizationId}|${periodKey(window.periodStart, window.periodEnd)}`;
    if (recordedKeys.has(key)) {
      skipped += 1;
      continue;
    }

    // A clipped window cannot reuse the month aggregate: that total covers the
    // whole month, including the part the cycle already billed.
    const counts =
      window.periodStart.getTime() === monthStart.getTime() &&
      window.periodEnd.getTime() === monthEnd.getTime()
        ? {
            workflowExecutions: row.workflowExecutions,
            directExecutions: row.directExecutions,
            total: row.total,
          }
        : await countExecutionsForPeriod(
            row.organizationId,
            window.periodStart,
            window.periodEnd
          );
    if (counts.total === 0) {
      continue;
    }

    const snapshot = planSnapshotFrom(subscriptions.get(row.organizationId));
    values.push({
      organizationId: row.organizationId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      // Best effort, and knowingly so: nothing stores what plan an
      // organization was on during a month that has already closed, so a
      // reconstructed row carries today's plan. Coverage above is exact; this
      // is not, and the invoices page prefers a billed record where one exists.
      plan: snapshot.plan,
      tier: snapshot.tier,
      executionLimit: snapshot.executionLimit,
      workflowExecutions: counts.workflowExecutions,
      directExecutions: counts.directExecutions,
      totalExecutions: counts.total,
      overageCount:
        snapshot.executionLimit === -1
          ? 0
          : Math.max(0, counts.total - snapshot.executionLimit),
      // No charge reaches this path: anything a provider cycle billed is
      // covered above and excluded, so what remains was never invoiced.
      totalChargeCents: 0,
      source: "calendar_month" as const,
    });
  }

  if (values.length === 0) {
    return summary(0, skipped, considered, 0);
  }

  let recorded = 0;
  let failed = 0;
  for (let i = 0; i < values.length; i += CALENDAR_CLOSE_INSERT_CHUNK) {
    const chunk = values.slice(i, i + CALENDAR_CLOSE_INSERT_CHUNK);
    try {
      const inserted = await db
        .insert(executionUsagePeriods)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ organizationId: executionUsagePeriods.organizationId });
      recorded += inserted.length;
    } catch (error) {
      // One chunk must not cost the rest of the span. Nothing is written for
      // it, so the next run picks the same months up again.
      failed += chunk.length;
      logSystemWarn(
        ErrorCategory.DATABASE,
        "[Billing] Calendar-month usage chunk failed",
        error,
        { operation: "closeCalendarMonthUsage" }
      );
    }
  }

  return summary(recorded, skipped, considered, failed);
}
