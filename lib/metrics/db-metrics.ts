/**
 * Database-backed Metrics Collection
 *
 * Queries execution statistics from the database and exposes them as Prometheus metrics.
 * This is necessary because workflow runner jobs exit before Prometheus can scrape them.
 *
 * These metrics are collected on each /api/metrics scrape to ensure fresh data.
 */

import "server-only";

import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  PLANS,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
// Every query in this module is a /api/metrics/db scrape aggregation, so they
// all run on the dedicated metrics pool (metricsDb) rather than the app's
// shared pool, which caps how many hit the DB at once - see metricsDb in
// @/lib/db for why.
import { metricsDb as db } from "@/lib/db";
import {
  apiKeys,
  chains,
  directExecutions,
  integrations,
  invitation,
  member,
  organization,
  organizationSubscriptions,
  organizationWallets,
  sessions,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflowRatings,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import { ERROR_STATUSES } from "@/lib/errors/execution-status";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import {
  ANONYMOUS_ORG_SLUG,
  NA_ERROR_TYPE,
} from "@/lib/metrics/metric-constants";
import type { BillingStatus } from "./types";

// Label value used for workflow executions whose workflow has no organization
// (personal/anonymous workflows). Keeps the per-(status, org_slug) execution
// gauge total equal to the global total instead of silently dropping these
// rows. Lives in metric-constants.ts (dependency-free) so the standalone
// executor can share it; re-exported here for existing import sites.
export { ANONYMOUS_ORG_SLUG } from "@/lib/metrics/metric-constants";

// Org slugs for the managed clients (Sky, Ajna) whose per-workflow error series
// power the managed-client user-error alerts. The per-workflow gauge is scoped
// to these slugs so `workflow_id` never becomes an unbounded label across the
// whole user base — only managed workflows that have errored emit a series.
// Mirrors `local.managed_org_slugs_regex` in the infra Grafana alert config;
// adding a managed org requires updating both lists.
export const MANAGED_ORG_SLUGS = ["techops-services", "ajna"] as const;

// Histogram bucket boundaries in milliseconds (must match prometheus.ts)
const WORKFLOW_DURATION_BUCKETS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 30_000,
];
const STEP_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000];

export type WorkflowStats = {
  // Total executions by status (sum across all orgs)
  totalSuccess: number;
  totalError: number;
  totalRunning: number;
  totalPending: number;
  totalCancelled: number;
  totalSkipped: number;

  // Per-(status, org_slug, error_type) execution counts. Personal/anonymous
  // workflows are bucketed under ANONYMOUS_ORG_SLUG so the sum of counts for
  // a given status across all orgs matches the corresponding total* above.
  //
  // errorType is read directly from the workflow_executions.error_type text
  // column (KEEP-545 rename — see drizzle/0077_error_type_label_rename.sql).
  // For non-error rows and for rows that predate classification, the column
  // is NULL; both cases are projected to a sentinel string so every gauge
  // series carries a populated label.
  //
  // errorType values:
  //   "user"    - errored row with error_type = 'user'
  //   "system"  - errored row with error_type = 'system'
  //   "unknown" - errored row with error_type IS NULL (predates classification)
  //   "na"      - non-error status (success/running/pending/cancelled)
  executionsByStatusAndOrgSlug: Array<{
    status: string;
    orgSlug: string;
    errorType: string;
    count: number;
  }>;

  // Duration histogram data (count of executions in each bucket)
  durationBuckets: number[];
  durationSum: number;
  durationCount: number;
};

/**
 * Query workflow execution statistics from the database
 *
 * Returns counts and duration distribution for all completed executions.
 * This data is used to populate Prometheus metrics on each scrape.
 */
export async function getWorkflowStatsFromDb(): Promise<WorkflowStats> {
  try {
    const stats: WorkflowStats = {
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      totalSkipped: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: new Array(WORKFLOW_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };

    // Per-(status, org_slug, error_type) execution breakdown: JOIN workflows +
    // organization, LEFT JOIN so anonymous workflows still contribute (under
    // ANONYMOUS_ORG_SLUG). GROUP BY uses the underlying columns (not the
    // COALESCE/CASE expressions): Drizzle would otherwise bind constants as
    // separate parameters in SELECT and GROUP BY clauses, and Postgres rejects
    // the query because the two expressions are not textually identical.
    // Postgres groups NULLs together (NULLs are equal in GROUP BY), and the
    // SELECT-side expressions render those groups as ANONYMOUS_ORG_SLUG /
    // "unknown" / "na" as appropriate.
    //
    // Bounded to startedAt >= now() - 30 days so the query is an index range
    // scan rather than a full-table scan that trips the 8s metrics
    // statement_timeout. startedAt is used instead of completedAt so in-flight
    // running/pending executions started within the window are included. The
    // 30-day window matches what the Grafana managed-client and system-error
    // alerts expect: both read keeperhub_workflow_executions_total directly
    // (no offset subtraction) as their 30-day volume denominator.
    const breakdown = await db
      .select({
        status: workflowExecutions.status,
        orgSlug: sql<string>`COALESCE(${organization.slug}, ${ANONYMOUS_ORG_SLUG})`,
        errorType: sql<string>`CASE
          WHEN ${notInArray(workflowExecutions.status, [...ERROR_STATUSES])} THEN ${NA_ERROR_TYPE}
          WHEN ${workflowExecutions.errorType} IS NULL THEN 'unknown'
          ELSE ${workflowExecutions.errorType}
        END`,
        count: count(),
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .leftJoin(organization, eq(workflows.organizationId, organization.id))
      .where(gte(workflowExecutions.startedAt, sql`now() - interval '30 days'`))
      .groupBy(
        workflowExecutions.status,
        organization.slug,
        workflowExecutions.errorType
      );

    for (const row of breakdown) {
      const c = Number(row.count) || 0;
      stats.executionsByStatusAndOrgSlug.push({
        status: row.status,
        orgSlug: row.orgSlug,
        errorType: row.errorType,
        count: c,
      });
      switch (row.status) {
        case "success":
          stats.totalSuccess += c;
          break;
        case "error":
          stats.totalError += c;
          break;
        case "running":
          stats.totalRunning += c;
          break;
        case "pending":
          stats.totalPending += c;
          break;
        case "cancelled":
          stats.totalCancelled += c;
          break;
        // Refused before starting: counted apart from errors so the 30-day
        // volume gauge does not read a refusal as a failure.
        case "skipped":
          stats.totalSkipped += c;
          break;
        default:
          // Ignore unknown status values
          break;
      }
    }

    // Query duration histogram data for completed executions
    // Build bucket counts using SQL CASE statements for efficiency
    const durationQuery = await db
      .select({
        totalCount: count(),
        totalSum: sql<number>`COALESCE(SUM(${workflowExecutions.duration}), 0)`,
        // Count executions in each bucket (cumulative)
        bucket0: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 100 THEN 1 ELSE 0 END)`,
        bucket1: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 250 THEN 1 ELSE 0 END)`,
        bucket2: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 500 THEN 1 ELSE 0 END)`,
        bucket3: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 1000 THEN 1 ELSE 0 END)`,
        bucket4: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 2000 THEN 1 ELSE 0 END)`,
        bucket5: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 5000 THEN 1 ELSE 0 END)`,
        bucket6: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 10000 THEN 1 ELSE 0 END)`,
        bucket7: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 30000 THEN 1 ELSE 0 END)`,
      })
      .from(workflowExecutions)
      .where(
        and(
          sql`${workflowExecutions.status} IN ('success', 'error', 'system_error')`,
          sql`${workflowExecutions.duration} IS NOT NULL`,
          gte(workflowExecutions.startedAt, sql`now() - interval '30 days'`)
        )
      );

    if (durationQuery[0]) {
      const row = durationQuery[0];
      stats.durationCount = Number(row.totalCount) || 0;
      stats.durationSum = Number(row.totalSum) || 0;
      stats.durationBuckets = [
        Number(row.bucket0) || 0,
        Number(row.bucket1) || 0,
        Number(row.bucket2) || 0,
        Number(row.bucket3) || 0,
        Number(row.bucket4) || 0,
        Number(row.bucket5) || 0,
        Number(row.bucket6) || 0,
        Number(row.bucket7) || 0,
        stats.durationCount, // +Inf bucket = total count
      ];
    }

    return stats;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query workflow stats from DB",
      error
    );
    // Return zeros on error to avoid breaking metrics endpoint
    return {
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      totalSkipped: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: new Array(WORKFLOW_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };
  }
}

/**
 * Seconds since the most recent workflow execution reached a terminal state
 * (anything with a non-NULL completed_at: success / error / cancelled), across
 * ALL trigger types and chains.
 *
 * Value = EXTRACT(EPOCH FROM now() - max(completed_at)). This is the freshness
 * signal behind the fast "zero finished executions" alert: under normal load
 * something finishes every few seconds, so the value sits well under a minute;
 * if the whole pipeline stalls (executor wedged, runner Jobs hanging, DB writes
 * failing) nothing updates completed_at and the value climbs without bound.
 *
 * Sourced from the DB so it is authoritative regardless of which (often
 * short-lived) pod finalized the execution - the same reason the rest of this
 * module reads the DB instead of per-pod counters. `completed_at IS NOT NULL`
 * matches the partial index idx_workflow_executions_completed_at, so this is an
 * index scan for max() rather than a full-table scan that would trip the 8s
 * metrics statement_timeout.
 *
 * `unconfirmed` rows are excluded: the finalizer stamps completed_at on them
 * (lib/workflow/executor/logging.ts) but they have not finished, so a pipeline
 * that only produces unconfirmed rows must still read as stalled. The filter
 * sits on top of the same partial index; the backward scan just steps past any
 * unconfirmed rows at the top, and those are rare.
 *
 * Returns null when the table has no finished executions yet (max is NULL) or
 * on query error; the caller leaves the gauge unset in that case so Prometheus
 * staleness / the alert's no_data_state governs rather than a misleading 0.
 */
export async function getLastFinishedExecutionAgeSecondsFromDb(): Promise<
  number | null
> {
  try {
    const rows = await db
      .select({
        ageSeconds: sql<
          number | null
        >`EXTRACT(EPOCH FROM (now() - max(${workflowExecutions.completedAt})))`,
      })
      .from(workflowExecutions)
      .where(
        and(
          sql`${workflowExecutions.completedAt} IS NOT NULL`,
          ne(workflowExecutions.status, "unconfirmed")
        )
      );

    const raw = rows[0]?.ageSeconds;
    return raw == null ? null : Number(raw);
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query last finished execution age from DB",
      error
    );
    return null;
  }
}

export type UnconfirmedExecutionCounts = {
  workflow: number;
  direct: number;
};

/**
 * Rows currently parked in `unconfirmed`: a transaction was broadcast but its
 * receipt could not be read when the run finalized. Only the
 * execution-reconciler CronJob moves these on, so a value that climbs and never
 * comes down means the reconciler is not running or cannot reach the chain.
 *
 * Both counts are equality lookups on a plain btree over status
 * (idx_workflow_executions_status, idx_direct_executions_status), and
 * `unconfirmed` is a rare value, so each is a small index scan rather than a
 * table scan.
 *
 * Returns null on query error; the caller leaves the gauge untouched so the
 * last real value stands rather than a misleading 0.
 */
export async function getUnconfirmedExecutionCountsFromDb(): Promise<UnconfirmedExecutionCounts | null> {
  try {
    const [workflowRows, directRows] = await Promise.all([
      db
        .select({ count: count() })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.status, "unconfirmed")),
      db
        .select({ count: count() })
        .from(directExecutions)
        .where(eq(directExecutions.status, "unconfirmed")),
    ]);
    return {
      workflow: Number(workflowRows[0]?.count) || 0,
      direct: Number(directRows[0]?.count) || 0,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query unconfirmed execution counts from DB",
      error
    );
    return null;
  }
}

// One cumulative all-time error count per (workflow_id, org_slug, error_type)
// for managed orgs. Mirrors the gauge semantics of
// executionsByStatusAndOrgSlug: a point-in-time snapshot the alert reads as
// `value(now) - value(now offset W)` to recover the delta over a window.
export type WorkflowErrorsByWorkflow = Array<{
  workflowId: string;
  orgSlug: string;
  errorType: string;
  count: number;
}>;

/**
 * Per-workflow error counts for managed orgs over a ROLLING 1-HOUR window,
 * sourced from the DB so the series is authoritative regardless of which
 * finalization path wrote the `status='error'` row.
 *
 * Value semantics: count of executions that errored in the last hour
 * (`completed_at >= now() - 1h`), per workflow. NOT an all-time cumulative
 * count. This matches the managed-client alert's "rolling 60-minute window"
 * definition, so the alert reads this gauge directly (no offset/delta math).
 *
 * Why windowed: the previous all-time variant filtered only on
 * `status='error'`, which matches every error execution across all orgs and
 * joins them before narrowing to managed orgs — at prod scale that blew past
 * the 8s metrics `statement_timeout` (Postgres 57014), the catch returned [],
 * and the gauge flapped (the series vanished on most scrapes). Bounding to the
 * last hour keeps the row set tiny so the query is an index range scan on
 * idx_workflow_executions_error_completed_at and finishes in milliseconds.
 *
 * Scoped to MANAGED_ORG_SLUGS to bound `workflow_id` cardinality. errorType is
 * the `workflow_executions.error_type` column, projected to "unknown" for
 * rows that predate classification so every series carries a populated label.
 */
export async function getWorkflowErrorsByWorkflowFromDb(): Promise<WorkflowErrorsByWorkflow> {
  try {
    const rows = await db
      .select({
        workflowId: workflowExecutions.workflowId,
        orgSlug: organization.slug,
        errorType: sql<string>`COALESCE(${workflowExecutions.errorType}, 'unknown')`,
        count: count(),
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .innerJoin(organization, eq(workflows.organizationId, organization.id))
      .where(
        and(
          inArray(workflowExecutions.status, [...ERROR_STATUSES]),
          sql`${workflowExecutions.completedAt} >= now() - interval '1 hour'`,
          inArray(organization.slug, [...MANAGED_ORG_SLUGS])
        )
      )
      .groupBy(
        workflowExecutions.workflowId,
        organization.slug,
        workflowExecutions.errorType
      );

    return rows.map((row) => ({
      workflowId: row.workflowId,
      orgSlug: row.orgSlug,
      errorType: row.errorType,
      count: Number(row.count) || 0,
    }));
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query per-workflow errors from DB",
      error
    );
    return [];
  }
}

// TECH-6544: per-(error_category, error_type) error counts over a ROLLING
// 1-HOUR window, PLATFORM-WIDE (all orgs). System errors are platform faults
// (DB, RPC, infra, workflow engine), not a managed-client concern, so this
// dedups by *cause* (error_category) across every org rather than by which
// workflow or org tripped. The infra P3 alert reads it filtered to
// error_type="system" and fires once per category spike. Dropping org_slug
// keeps cardinality FIXED (~categories * ~types) regardless of customer count.
export type SystemErrorsByCategory = Array<{
  errorCategory: string;
  errorType: string;
  count: number;
}>;

/**
 * Per-(error_category, error_type) error counts over a ROLLING 1-HOUR window,
 * platform-wide, sourced from the DB so the series is authoritative regardless
 * of which finalization path wrote the `status='error'` row.
 *
 * Value semantics: count of executions that errored in the last hour
 * (`completed_at >= now() - 1h`), per (error_category, error_type). NOT an
 * all-time cumulative count. This matches the infra P3 alert's "rolling
 * 60-minute window" definition, so the alert reads this gauge directly (no
 * offset/delta math).
 *
 * Why dedup by category (not org or workflow): a system fault — e.g. an RPC
 * outage — surfaces across many workflows and orgs at once. Grouping by cause
 * collapses all of them into one series per (error_category, error_type), so
 * the P3 alert pages once per distinct failure mode, not once per affected
 * workflow/org. org_slug is intentionally NOT a label: a platform fault is
 * org-agnostic, and omitting it pins cardinality so it can't grow with the
 * customer base. Per-org context, if ever needed, lives on other org-labelled
 * metrics / dashboards.
 *
 * Why windowed: filtering only on `status='error'` matches every error
 * execution ever, which at prod scale blew past the 8s metrics
 * `statement_timeout` (Postgres 57014), the catch returned [], and the gauge
 * flapped. Bounding to the last hour keeps the row set tiny so the query is an
 * index range scan on idx_workflow_executions_error_completed_at and finishes
 * in milliseconds. error_category/error_type live on workflow_executions
 * directly (migration 0073); the workflows/organization left joins below exist
 * only to resolve org_slug for the network_rpc scoping, and stay left joins so
 * a row with no resolvable org still counts for every other category.
 *
 * errorCategory and errorType are read from the `workflow_executions`
 * error_category / error_type columns, projected to "unknown" for rows that
 * predate classification so every series carries populated labels. Cardinality
 * is bounded at roughly (~11 categories) * (~3 error types) — small and stable.
 *
 * network_rpc is the one exception to "platform-wide, no org filter": rows are
 * scoped to MANAGED_ORG_SLUGS the same way the per-workflow gauge is. This still
 * adds no org_slug label, it only narrows which rows count toward the
 * network_rpc series, so cardinality stays fixed.
 */
export async function getSystemErrorsByCategoryFromDb(): Promise<SystemErrorsByCategory> {
  try {
    const rows = await db
      .select({
        errorCategory: sql<string>`COALESCE(${workflowExecutions.errorCategory}, 'unknown')`,
        errorType: sql<string>`COALESCE(${workflowExecutions.errorType}, 'unknown')`,
        count: count(),
      })
      .from(workflowExecutions)
      .leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .leftJoin(organization, eq(workflows.organizationId, organization.id))
      .where(
        and(
          // KEEP-853: system errors carry status='system_error' (not 'error'),
          // so both must be matched or every system error drops out of the gauge
          // the infra P3 alert reads.
          inArray(workflowExecutions.status, [...ERROR_STATUSES]),
          sql`${workflowExecutions.completedAt} >= now() - interval '1 hour'`,
          or(
            sql`${workflowExecutions.errorCategory} IS DISTINCT FROM 'network_rpc'`,
            inArray(organization.slug, [...MANAGED_ORG_SLUGS])
          )
        )
      )
      .groupBy(workflowExecutions.errorCategory, workflowExecutions.errorType);

    return rows.map((row) => ({
      errorCategory: row.errorCategory,
      errorType: row.errorType,
      count: Number(row.count) || 0,
    }));
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query system errors by category from DB",
      error
    );
    return [];
  }
}

export type StepStats = {
  // Counts by step type and status
  countsByType: Record<string, { success: number; error: number }>;

  // Duration histogram data (count of steps in each bucket)
  durationBuckets: number[];
  durationSum: number;
  durationCount: number;
};

// Helper to parse step duration buckets from query result
function parseStepDurationBuckets(row: {
  totalCount: number;
  totalSum: number;
  bucket0: number;
  bucket1: number;
  bucket2: number;
  bucket3: number;
  bucket4: number;
  bucket5: number;
  bucket6: number;
}): { buckets: number[]; sum: number; count: number } {
  const totalCount = Number(row.totalCount) || 0;
  return {
    count: totalCount,
    sum: Number(row.totalSum) || 0,
    buckets: [
      Number(row.bucket0) || 0,
      Number(row.bucket1) || 0,
      Number(row.bucket2) || 0,
      Number(row.bucket3) || 0,
      Number(row.bucket4) || 0,
      Number(row.bucket5) || 0,
      Number(row.bucket6) || 0,
      totalCount, // +Inf bucket = total count
    ],
  };
}

/**
 * Query step execution statistics from the database
 *
 * Returns counts and duration distribution for all completed steps.
 * This data is used to populate Prometheus metrics on each scrape.
 */
export async function getStepStatsFromDb(): Promise<StepStats> {
  try {
    // Query step counts by type and status
    const typeCounts = await db
      .select({
        nodeType: workflowExecutionLogs.nodeType,
        status: workflowExecutionLogs.status,
        count: count(),
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          sql`${workflowExecutionLogs.status} IN ('success', 'error')`,
          gte(workflowExecutionLogs.startedAt, sql`now() - interval '1 hour'`)
        )
      )
      .groupBy(workflowExecutionLogs.nodeType, workflowExecutionLogs.status);

    const stats: StepStats = {
      countsByType: {},
      durationBuckets: new Array(STEP_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };

    for (const row of typeCounts) {
      if (!stats.countsByType[row.nodeType]) {
        stats.countsByType[row.nodeType] = { success: 0, error: 0 };
      }
      if (row.status === "success") {
        stats.countsByType[row.nodeType].success = row.count;
      } else if (row.status === "error") {
        stats.countsByType[row.nodeType].error = row.count;
      }
    }

    // Query duration histogram data for completed steps
    const durationQuery = await db
      .select({
        totalCount: count(),
        totalSum: sql<number>`COALESCE(SUM(${workflowExecutionLogs.duration}), 0)`,
        // Count steps in each bucket (cumulative)
        bucket0: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 50 THEN 1 ELSE 0 END)`,
        bucket1: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 100 THEN 1 ELSE 0 END)`,
        bucket2: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 250 THEN 1 ELSE 0 END)`,
        bucket3: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 500 THEN 1 ELSE 0 END)`,
        bucket4: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 1000 THEN 1 ELSE 0 END)`,
        bucket5: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 2000 THEN 1 ELSE 0 END)`,
        bucket6: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 5000 THEN 1 ELSE 0 END)`,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          sql`${workflowExecutionLogs.status} IN ('success', 'error')`,
          sql`${workflowExecutionLogs.duration} IS NOT NULL`,
          gte(workflowExecutionLogs.startedAt, sql`now() - interval '1 hour'`)
        )
      );

    if (durationQuery[0]) {
      const parsed = parseStepDurationBuckets(durationQuery[0]);
      stats.durationCount = parsed.count;
      stats.durationSum = parsed.sum;
      stats.durationBuckets = parsed.buckets;
    }

    return stats;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query step stats from DB",
      error
    );
    // Return zeros on error to avoid breaking metrics endpoint
    return {
      countsByType: {},
      durationBuckets: new Array(STEP_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };
  }
}

/**
 * Query daily active users from the database
 *
 * Returns count of distinct users with active sessions in the last 24 hours.
 */
export async function getDailyActiveUsersFromDb(): Promise<number> {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await db
      .select({
        count: countDistinct(sessions.userId),
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.updatedAt, oneDayAgo),
          gte(sessions.expiresAt, new Date()) // Only count non-expired sessions
        )
      );

    return Number(result[0]?.count) || 0;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query daily active users from DB",
      error
    );
    return 0;
  }
}

export type UserStats = {
  total: number;
  verified: number;
  anonymous: number;
  withWorkflows: number;
  withIntegrations: number;
};

/**
 * Query user statistics from the database
 *
 * Returns counts of users by various categories.
 */
export async function getUserStatsFromDb(): Promise<UserStats> {
  try {
    const [
      totalResult,
      verifiedResult,
      anonymousResult,
      withWorkflowsResult,
      withIntegrationsResult,
    ] = await Promise.all([
      // Total users
      db.select({ count: count() }).from(users),
      // Verified users
      db
        .select({ count: count() })
        .from(users)
        .where(eq(users.emailVerified, true)),
      // Anonymous users
      db
        .select({ count: count() })
        .from(users)
        .where(eq(users.isAnonymous, true)),
      // Users with at least one workflow
      db.select({ count: countDistinct(workflows.userId) }).from(workflows),
      // Users with at least one integration
      db
        .select({ count: countDistinct(integrations.createdBy) })
        .from(integrations),
    ]);

    return {
      total: Number(totalResult[0]?.count) || 0,
      verified: Number(verifiedResult[0]?.count) || 0,
      anonymous: Number(anonymousResult[0]?.count) || 0,
      withWorkflows: Number(withWorkflowsResult[0]?.count) || 0,
      withIntegrations: Number(withIntegrationsResult[0]?.count) || 0,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query user stats from DB",
      error
    );
    return {
      total: 0,
      verified: 0,
      anonymous: 0,
      withWorkflows: 0,
      withIntegrations: 0,
    };
  }
}

export type OrgStats = {
  total: number;
  membersTotal: number;
  membersByRole: Record<string, number>;
  invitationsPending: number;
  withWorkflows: number;
};

/**
 * Query organization statistics from the database
 *
 * Returns counts of organizations and their members.
 */
export async function getOrgStatsFromDb(): Promise<OrgStats> {
  try {
    const [
      totalResult,
      membersTotalResult,
      membersByRoleResult,
      invitationsPendingResult,
      withWorkflowsResult,
    ] = await Promise.all([
      // Total organizations
      db.select({ count: count() }).from(organization),
      // Total members across all orgs
      db.select({ count: count() }).from(member),
      // Members grouped by role
      db
        .select({
          role: member.role,
          count: count(),
        })
        .from(member)
        .groupBy(member.role),
      // Pending invitations
      db
        .select({ count: count() })
        .from(invitation)
        .where(eq(invitation.status, "pending")),
      // Organizations with at least one workflow
      db
        .select({ count: countDistinct(workflows.organizationId) })
        .from(workflows)
        .where(sql`${workflows.organizationId} IS NOT NULL`),
    ]);

    const membersByRole: Record<string, number> = {};
    for (const row of membersByRoleResult) {
      membersByRole[row.role] = row.count;
    }

    return {
      total: Number(totalResult[0]?.count) || 0,
      membersTotal: Number(membersTotalResult[0]?.count) || 0,
      membersByRole,
      invitationsPending: Number(invitationsPendingResult[0]?.count) || 0,
      withWorkflows: Number(withWorkflowsResult[0]?.count) || 0,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query org stats from DB",
      error
    );
    return {
      total: 0,
      membersTotal: 0,
      membersByRole: {},
      invitationsPending: 0,
      withWorkflows: 0,
    };
  }
}

export type UserListEntry = {
  email: string;
  name: string;
  verified: boolean;
  createdAt: Date;
};

export async function getUserListFromDb(): Promise<UserListEntry[]> {
  try {
    const result = await db
      .select({
        email: users.email,
        name: users.name,
        verified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.isAnonymous, false));

    return result.map((row) => ({
      email: row.email ?? "unknown",
      name: row.name ?? "unknown",
      verified: row.verified,
      createdAt: row.createdAt,
    }));
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query user list from DB",
      error
    );
    return [];
  }
}

export type OrgListEntry = {
  name: string;
  slug: string;
  plan: PlanName;
  tier: TierKey | null;
  billingStatus: BillingStatus;
};

const VALID_BILLING_STATUSES: ReadonlySet<string> = new Set<BillingStatus>([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
  "none",
]);

function parseBillingStatus(value: unknown): BillingStatus {
  return typeof value === "string" && VALID_BILLING_STATUSES.has(value)
    ? (value as BillingStatus)
    : "none";
}

export async function getOrgListFromDb(): Promise<OrgListEntry[]> {
  try {
    const result = await db
      .select({
        name: organization.name,
        slug: organization.slug,
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        billingStatus: organizationSubscriptions.status,
      })
      .from(organization)
      .leftJoin(
        organizationSubscriptions,
        eq(organizationSubscriptions.organizationId, organization.id)
      );

    return result.map((row) => ({
      name: row.name,
      slug: row.slug,
      plan: parsePlanName(row.plan, "free"),
      tier: parseTierKey(row.tier),
      billingStatus:
        row.billingStatus === null
          ? "none"
          : parseBillingStatus(row.billingStatus),
    }));
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query org list from DB",
      error
    );
    return [];
  }
}

export type WorkflowDefinitionStats = {
  total: number;
  public: number;
  private: number;
  anonymous: number;
};

/**
 * Query workflow definition statistics from the database
 *
 * Returns counts of workflows by visibility and anonymity.
 */
export async function getWorkflowDefinitionStatsFromDb(): Promise<WorkflowDefinitionStats> {
  try {
    const [totalResult, publicResult, anonymousResult] = await Promise.all([
      db.select({ count: count() }).from(workflows),
      db
        .select({ count: count() })
        .from(workflows)
        .where(eq(workflows.visibility, "public")),
      db
        .select({ count: count() })
        .from(workflows)
        .where(eq(workflows.isAnonymous, true)),
    ]);

    const total = Number(totalResult[0]?.count) || 0;
    const publicCount = Number(publicResult[0]?.count) || 0;

    return {
      total,
      public: publicCount,
      private: total - publicCount,
      anonymous: Number(anonymousResult[0]?.count) || 0,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query workflow definition stats from DB",
      error
    );
    return { total: 0, public: 0, private: 0, anonymous: 0 };
  }
}

export type ScheduleStats = {
  total: number;
  enabled: number;
  disabled: number;
  byLastStatus: Record<string, number>;
};

/**
 * Query schedule statistics from the database
 *
 * Returns counts of schedules by enabled state and last run status.
 */
export async function getScheduleStatsFromDb(): Promise<ScheduleStats> {
  try {
    const [totalResult, enabledResult, statusResult] = await Promise.all([
      db.select({ count: count() }).from(workflowSchedules),
      db
        .select({ count: count() })
        .from(workflowSchedules)
        .where(eq(workflowSchedules.enabled, true)),
      db
        .select({
          status: workflowSchedules.lastStatus,
          count: count(),
        })
        .from(workflowSchedules)
        .where(sql`${workflowSchedules.lastStatus} IS NOT NULL`)
        .groupBy(workflowSchedules.lastStatus),
    ]);

    const total = Number(totalResult[0]?.count) || 0;
    const enabled = Number(enabledResult[0]?.count) || 0;

    const byLastStatus: Record<string, number> = {};
    for (const row of statusResult) {
      if (row.status) {
        byLastStatus[row.status] = row.count;
      }
    }

    return {
      total,
      enabled,
      disabled: total - enabled,
      byLastStatus,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query schedule stats from DB",
      error
    );
    return { total: 0, enabled: 0, disabled: 0, byLastStatus: {} };
  }
}

export type IntegrationStats = {
  total: number;
  managed: number;
  byType: Record<string, number>;
};

/**
 * Query integration statistics from the database
 *
 * Returns counts of integrations by type and managed status.
 */
export async function getIntegrationStatsFromDb(): Promise<IntegrationStats> {
  try {
    const [totalResult, managedResult, typeResult] = await Promise.all([
      db.select({ count: count() }).from(integrations),
      db
        .select({ count: count() })
        .from(integrations)
        .where(eq(integrations.isManaged, true)),
      db
        .select({
          type: integrations.type,
          count: count(),
        })
        .from(integrations)
        .groupBy(integrations.type),
    ]);

    const byType: Record<string, number> = {};
    for (const row of typeResult) {
      byType[row.type] = row.count;
    }

    return {
      total: Number(totalResult[0]?.count) || 0,
      managed: Number(managedResult[0]?.count) || 0,
      byType,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query integration stats from DB",
      error
    );
    return { total: 0, managed: 0, byType: {} };
  }
}

export type InfraStats = {
  apiKeysTotal: number;
  chainsTotal: number;
  chainsEnabled: number;
  walletsTotal: number;
  sessionsActive: number;
};

/**
 * Query infrastructure statistics from the database
 *
 * Returns counts of API keys, chains, wallets, and active sessions.
 */
export async function getInfraStatsFromDb(): Promise<InfraStats> {
  try {
    const now = new Date();

    const [
      apiKeysResult,
      chainsResult,
      chainsEnabledResult,
      walletsResult,
      sessionsResult,
    ] = await Promise.all([
      db.select({ count: count() }).from(apiKeys),
      db.select({ count: count() }).from(chains),
      db
        .select({ count: count() })
        .from(chains)
        .where(eq(chains.isEnabled, true)),
      db
        .select({ count: count() })
        .from(organizationWallets)
        .where(eq(organizationWallets.isActive, true)),
      db
        .select({ count: count() })
        .from(sessions)
        .where(gte(sessions.expiresAt, now)),
    ]);

    return {
      apiKeysTotal: Number(apiKeysResult[0]?.count) || 0,
      chainsTotal: Number(chainsResult[0]?.count) || 0,
      chainsEnabled: Number(chainsEnabledResult[0]?.count) || 0,
      walletsTotal: Number(walletsResult[0]?.count) || 0,
      sessionsActive: Number(sessionsResult[0]?.count) || 0,
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query infra stats from DB",
      error
    );
    return {
      apiKeysTotal: 0,
      chainsTotal: 0,
      chainsEnabled: 0,
      walletsTotal: 0,
      sessionsActive: 0,
    };
  }
}

export type VoteStats = {
  totalVotes: number;
  totalUpvotes: number;
  totalDownvotes: number;
  topWorkflows: { workflowId: string; score: number }[];
  mostClonedWorkflows: {
    workflowId: string;
    cloneCount: number;
  }[];
  topVoters: { userId: string; voteCount: number }[];
};

export async function getVoteStatsFromDb(): Promise<VoteStats> {
  try {
    const [
      totalsResult,
      topWorkflowsResult,
      mostClonedResult,
      topVotersResult,
    ] = await Promise.all([
      db
        .select({
          totalVotes: count(),
          totalUpvotes: sql<string>`COUNT(*) FILTER (WHERE ${workflowRatings.rating} = 1)`,
          totalDownvotes: sql<string>`COUNT(*) FILTER (WHERE ${workflowRatings.rating} = -1)`,
        })
        .from(workflowRatings),
      db
        .select({
          workflowId: workflowRatings.workflowId,
          score: sql<string>`COALESCE(SUM(${workflowRatings.rating}), 0)`,
        })
        .from(workflowRatings)
        .groupBy(workflowRatings.workflowId)
        .orderBy(sql`SUM(${workflowRatings.rating}) DESC`)
        .limit(10),
      db
        .select({
          workflowId: workflows.sourceWorkflowId,
          cloneCount: count(),
        })
        .from(workflows)
        .where(sql`${workflows.sourceWorkflowId} IS NOT NULL`)
        .groupBy(workflows.sourceWorkflowId)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10),
      db
        .select({
          userId: workflowRatings.userId,
          voteCount: count(),
        })
        .from(workflowRatings)
        .groupBy(workflowRatings.userId)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10),
    ]);

    const totals = totalsResult[0];

    return {
      totalVotes: Number(totals?.totalVotes) || 0,
      totalUpvotes: Number(totals?.totalUpvotes) || 0,
      totalDownvotes: Number(totals?.totalDownvotes) || 0,
      topWorkflows: topWorkflowsResult.map((r) => ({
        workflowId: r.workflowId,
        score: Number(r.score),
      })),
      mostClonedWorkflows: mostClonedResult
        .filter((r) => r.workflowId !== null)
        .map((r) => ({
          workflowId: r.workflowId as string,
          cloneCount: Number(r.cloneCount),
        })),
      topVoters: topVotersResult.map((r) => ({
        userId: r.userId,
        voteCount: Number(r.voteCount),
      })),
    };
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query vote stats from DB",
      error
    );
    return {
      totalVotes: 0,
      totalUpvotes: 0,
      totalDownvotes: 0,
      topWorkflows: [],
      mostClonedWorkflows: [],
      topVoters: [],
    };
  }
}

/**
 * Query names of all enabled chains from the database.
 * Used to pre-initialize RPC metrics so every chain appears in Grafana.
 */
export async function getEnabledChainNamesFromDb(): Promise<string[]> {
  try {
    const results = await db
      .select({ name: chains.name })
      .from(chains)
      .where(eq(chains.isEnabled, true));

    return results.map((r) => r.name);
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query enabled chain names",
      error
    );
    return [];
  }
}

// Subscription statuses that carry a priced tier. Kept inline in the SQL
// query (active / trialing / past_due). Canceled / unpaid / paused
// subscriptions do not contribute.
//
// Not every priced status is committed revenue. A trialing org pays nothing
// yet, so it is reported as its own labelled series and left out of the
// total. See MRR_COMMITTED_STATUSES below.

export type BillingStats = {
  // Org count per (plan, tier, billing_status). One entry per unique
  // combination. tier is null for free and enterprise (no tier system).
  orgsByPlan: Array<{
    plan: PlanName;
    tier: TierKey | null;
    billingStatus: BillingStatus;
    count: number;
  }>;

  // Per-org execution counts. One entry per org (free + paid).
  orgsExecutions: Array<{
    orgSlug: string;
    plan: PlanName;
    exec30d: number;
    execMonth: number;
    // Monthly execution allowance for the org's tier, or -1 for unlimited
    // (enterprise) and 0 when not applicable.
    monthlyLimit: number;
  }>;

  // Approximate MRR in USD cents per (plan, tier, billing_status), computed
  // from PLANS[plan].tiers[tier].monthlyPrice. Stripe remains the source of
  // truth for accounting. The billingStatus split lets a consumer separate
  // committed revenue from trial pipeline revenue.
  mrrCentsByPlan: Array<{
    plan: PlanName;
    tier: TierKey | null;
    billingStatus: BillingStatus;
    cents: number;
  }>;

  // Committed MRR in USD cents across all plans and tiers. Counts the
  // statuses in MRR_COMMITTED_STATUSES only, so a trialing org contributes
  // nothing until it converts. Read mrrCentsByPlan for the trial pipeline.
  mrrCentsTotal: number;

  // Trial funnel snapshot: orgs that have ever started a trial, by current
  // outcome. "active" = still trialing, "converted" = now paying (came from a
  // trial), "churned" = trialed but no longer active.
  trialsByOutcome: Array<{
    outcome: TrialOutcome;
    count: number;
  }>;
};

export type TrialOutcome = "active" | "converted" | "churned";

const VALID_TRIAL_OUTCOMES: ReadonlySet<string> = new Set<TrialOutcome>([
  "active",
  "converted",
  "churned",
]);

// Billing statuses that count as committed revenue in mrrCentsTotal. A
// past_due org stays on the plan and is still billed, so it counts. A
// trialing org pays nothing yet, so it does not.
//
// Tested against the parsed status rather than a "not trialing" check, so
// the total stays correct if the SQL query widens its status filter.
const MRR_COMMITTED_STATUSES: ReadonlySet<BillingStatus> =
  new Set<BillingStatus>(["active", "past_due"]);

function emptyBillingStats(): BillingStats {
  return {
    orgsByPlan: [],
    orgsExecutions: [],
    mrrCentsByPlan: [],
    mrrCentsTotal: 0,
    trialsByOutcome: [],
  };
}

function tierMonthlyPriceCents(plan: PlanName, tier: TierKey | null): number {
  if (!tier) {
    return 0;
  }
  const planDef = PLANS[plan];
  const found = planDef.tiers.find((t) => t.key === tier);
  return found ? Math.round(found.monthlyPrice * 100) : 0;
}

/**
 * Query billing-aware metrics from the database in a single pass.
 *
 * Joins workflow_executions -> workflows -> organization -> organization_subscriptions
 * to produce per-org execution counts (30-day rolling and current-month-to-date),
 * org distribution by plan/billing status, and a directional MRR figure.
 */
export async function getBillingStatsFromDb(): Promise<BillingStats> {
  try {
    // Aggregate counts: orgs by (plan, tier, billing_status). LEFT JOIN
    // handles legacy orgs without a subscription row (mapped to plan="free",
    // billing_status="none" via fallback in OrgListEntry parsing).
    const orgsByPlanResult = await db
      .select({
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        status: organizationSubscriptions.status,
        count: count(),
      })
      .from(organization)
      .leftJoin(
        organizationSubscriptions,
        eq(organizationSubscriptions.organizationId, organization.id)
      )
      .groupBy(
        organizationSubscriptions.plan,
        organizationSubscriptions.tier,
        organizationSubscriptions.status
      );

    // Per-org executions in the last 30 days + current month. We compute
    // both windows in one query using FILTER clauses, then bucket free orgs
    // in JS to keep the SQL straightforward. Anonymous workflows (no
    // organization) are excluded — they're already covered by ANONYMOUS_ORG_SLUG
    // in the per-org error gauge.
    // Only billable rows count: this matches the billing guard's
    // countMonthlyExecutions predicate, so the plan-usage ratio reflects quota
    // actually consumed. Excludes billing-blocked phantom rows (never ran) and
    // x402 pay-per-call runs (paid per call, no quota consumed) — without the
    // filter a capped free org's blocked triggers inflate the ratio far past 1.
    const execByOrgResult = await db
      .select({
        orgSlug: organization.slug,
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        exec30d: count(),
        execMonth: sql<string>`COUNT(*) FILTER (WHERE ${workflowExecutions.startedAt} >= date_trunc('month', NOW()))`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .innerJoin(organization, eq(workflows.organizationId, organization.id))
      .leftJoin(
        organizationSubscriptions,
        eq(organizationSubscriptions.organizationId, organization.id)
      )
      .where(
        sql`${workflowExecutions.startedAt} >= NOW() - INTERVAL '30 days'
            AND ${workflowExecutions.billable} = TRUE`
      )
      .groupBy(
        organization.slug,
        organizationSubscriptions.plan,
        organizationSubscriptions.tier
      );

    // Priced-subscription tier list for MRR computation. We include past_due
    // because those orgs are still on the plan; only canceled/unpaid/paused
    // are excluded. We also include trialing, but the status comes back with
    // the row so the tally can keep trial revenue out of the total.
    const mrrSubsResult = await db
      .select({
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        status: organizationSubscriptions.status,
      })
      .from(organizationSubscriptions)
      .where(
        sql`${organizationSubscriptions.status} IN ('active', 'trialing', 'past_due')`
      );

    // Trial funnel snapshot: any org that ever started a trial
    // (trial_started_at IS NOT NULL), grouped by current outcome. Bounded to
    // trial-touched rows so it stays a small aggregate.
    const trialOutcomeResult = await db
      .select({
        outcome: sql<string>`CASE
          WHEN ${organizationSubscriptions.status} = 'trialing' THEN 'active'
          WHEN ${organizationSubscriptions.status} = 'active' THEN 'converted'
          ELSE 'churned'
        END`,
        count: count(),
      })
      .from(organizationSubscriptions)
      .where(sql`${organizationSubscriptions.trialStartedAt} IS NOT NULL`)
      .groupBy(sql`1`);

    const stats = emptyBillingStats();

    // Tally orgs by plan + tier + billing_status
    for (const row of orgsByPlanResult) {
      const plan = parsePlanName(row.plan, "free");
      const tier = parseTierKey(row.tier);
      const billingStatus: BillingStatus =
        row.status === null ? "none" : parseBillingStatus(row.status);
      const count = Number(row.count);
      const existing = stats.orgsByPlan.find(
        (e) =>
          e.plan === plan &&
          e.tier === tier &&
          e.billingStatus === billingStatus
      );
      if (existing) {
        existing.count += count;
      } else {
        stats.orgsByPlan.push({ plan, tier, billingStatus, count });
      }
    }

    // Tally per-org executions — one entry per org (free + paid)
    for (const row of execByOrgResult) {
      const plan = parsePlanName(row.plan, "free");
      const tier = parseTierKey(row.tier);
      const exec30d = Number(row.exec30d) || 0;
      const execMonth = Number(row.execMonth) || 0;

      const monthlyLimit = PLANS[plan].features.maxExecutionsPerMonth;
      const tierLimit =
        tier === null
          ? monthlyLimit
          : (PLANS[plan].tiers.find((t) => t.key === tier)?.executions ??
            monthlyLimit);

      stats.orgsExecutions.push({
        orgSlug: row.orgSlug,
        plan,
        exec30d,
        execMonth,
        monthlyLimit: tierLimit,
      });
    }

    // Compute MRR per (plan, tier, billing_status) from priced subscriptions
    // × tier price. Only committed statuses reach the total.
    for (const row of mrrSubsResult) {
      const plan = parsePlanName(row.plan, "free");
      const tier = parseTierKey(row.tier);
      const billingStatus = parseBillingStatus(row.status);
      const cents = tierMonthlyPriceCents(plan, tier);
      const existing = stats.mrrCentsByPlan.find(
        (e) =>
          e.plan === plan &&
          e.tier === tier &&
          e.billingStatus === billingStatus
      );
      if (existing) {
        existing.cents += cents;
      } else {
        stats.mrrCentsByPlan.push({ plan, tier, billingStatus, cents });
      }
      if (MRR_COMMITTED_STATUSES.has(billingStatus)) {
        stats.mrrCentsTotal += cents;
      }
    }

    // Tally trial outcomes (active / converted / churned)
    for (const row of trialOutcomeResult) {
      if (VALID_TRIAL_OUTCOMES.has(row.outcome)) {
        stats.trialsByOutcome.push({
          outcome: row.outcome as TrialOutcome,
          count: Number(row.count) || 0,
        });
      }
    }

    return stats;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Metrics] Failed to query billing stats from DB",
      error
    );
    return emptyBillingStats();
  }
}

export type ProbeChainConfig = {
  chainId: number;
  name: string;
  chainType: string;
  defaultPrimaryRpc: string;
  defaultFallbackRpc: string | null;
};

/**
 * Query all enabled chain configs for the active RPC health probe.
 * Returns chain metadata + default RPC URLs for both primary and fallback.
 */
export async function getEnabledChainConfigsForProbe(): Promise<
  ProbeChainConfig[]
> {
  try {
    return await db
      .select({
        chainId: chains.chainId,
        name: chains.name,
        chainType: chains.chainType,
        defaultPrimaryRpc: chains.defaultPrimaryRpc,
        defaultFallbackRpc: chains.defaultFallbackRpc,
      })
      .from(chains)
      .where(eq(chains.isEnabled, true));
  } catch {
    return [];
  }
}
