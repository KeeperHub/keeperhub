import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type ExecutionUsagePeriodSource,
  executionUsagePeriods,
  organizationSubscriptions,
} from "@/lib/db/schema";
import { startOfCurrentMonthUtc } from "./execution-limit-core";
import {
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
   * `isOnProviderCycle`.
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
 * Whether an organization's usage is already covered by its own provider cycle.
 *
 * Carrying period columns is not enough to decide this, and assuming it was is a
 * bug that lasted until it was measured. `subscription.deleted` sets the plan to
 * free and the status to canceled but never clears `current_period_start` /
 * `current_period_end`, so a churned organization keeps its final period on the
 * row forever. Treating that as "on a cycle" excludes it from the month close
 * permanently, while it carries on running on the free plan and no cycle record
 * will ever be written for it again - its usage simply disappears.
 *
 * Only a period that has not ended yet will produce another cycle record, so
 * that, and not the presence of the columns, is the test.
 */
export function isOnProviderCycle(
  sub: Pick<SubscriptionPlanRow, "currentPeriodEnd"> | undefined,
  now: Date
): boolean {
  return sub?.currentPeriodEnd != null && sub.currentPeriodEnd > now;
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
 * period-close hooks make that window small, and the backfill cannot do better
 * than today's plan for history it reconstructs.
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

  const overageCount =
    planSnapshot.executionLimit === -1
      ? 0
      : Math.max(0, counts.total - planSnapshot.executionLimit);

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
      totalExecutions: counts.total,
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
  periodStart: string;
  periodEnd: string;
  /** Organizations billed on the calendar month that ran something. */
  considered: number;
  /** Rows written by this run. */
  recorded: number;
  /** Already written by an earlier run, so skipped without counting again. */
  skipped: number;
};

/**
 * Freeze the calendar month that just closed, for every organization billed on
 * it.
 *
 * An organization billed on a provider cycle is deliberately not here. Its
 * period is not the calendar month, and its record is written by
 * `billOverageForOrg` when that cycle closes; writing a month row for it as
 * well would store a window nothing ever reads.
 *
 * Everyone else is covered here, and that is most of the product: an
 * organization with no `organization_subscriptions` row at all has no period
 * boundary anywhere, so without this pass its usage is never frozen and a
 * closed month survives only as the execution rows themselves.
 *
 * Four queries regardless of how many organizations there are: the usage
 * aggregate, the subscription read, the already-recorded read, and one insert.
 */
export async function closeCalendarMonthUsage(
  now: Date = new Date()
): Promise<CalendarCloseSummary> {
  const { periodStart, periodEnd } = previousCalendarMonth(now);
  const summary = (recorded: number, skipped: number, considered: number) => ({
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    considered,
    recorded,
    skipped,
  });

  const usage = await countExecutionsByOrgForPeriod(periodStart, periodEnd);
  if (usage.length === 0) {
    return summary(0, 0, 0);
  }

  const subscriptions = await getSubscriptionsByOrg(
    usage.map((row) => row.organizationId)
  );

  const onCalendarMonth = usage.filter(
    (row) => !isOnProviderCycle(subscriptions.get(row.organizationId), now)
  );
  if (onCalendarMonth.length === 0) {
    return summary(0, 0, 0);
  }

  const alreadyRecorded = await getRecordedOrganizationIds(
    onCalendarMonth.map((row) => row.organizationId),
    periodStart,
    periodEnd
  );

  const pending = onCalendarMonth.filter(
    (row) => !alreadyRecorded.has(row.organizationId)
  );
  if (pending.length === 0) {
    return summary(0, alreadyRecorded.size, onCalendarMonth.length);
  }

  const values = pending.map((row) => {
    const snapshot = planSnapshotFrom(subscriptions.get(row.organizationId));
    return {
      organizationId: row.organizationId,
      periodStart,
      periodEnd,
      plan: snapshot.plan,
      tier: snapshot.tier,
      executionLimit: snapshot.executionLimit,
      workflowExecutions: row.workflowExecutions,
      directExecutions: row.directExecutions,
      totalExecutions: row.total,
      overageCount:
        snapshot.executionLimit === -1
          ? 0
          : Math.max(0, row.total - snapshot.executionLimit),
      // A calendar-month organization is on a plan that does not bill overage,
      // so there is no charge to carry. A charge only ever reaches a record
      // through the provider path, which stamps it separately.
      totalChargeCents: 0,
      source: "calendar_month" as const,
    };
  });

  const inserted = await db
    .insert(executionUsagePeriods)
    .values(values)
    .onConflictDoNothing()
    .returning({ organizationId: executionUsagePeriods.organizationId });

  return summary(inserted.length, alreadyRecorded.size, onCalendarMonth.length);
}
