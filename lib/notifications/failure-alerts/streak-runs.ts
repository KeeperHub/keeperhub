import "server-only";

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory } from "@/lib/logging";
import { isRefusedRun, type StreakRun } from "./streak";

/** workflow_executions or an alias of it. */
type Runs = Record<
  | "status"
  | "errorCategory"
  | "billable"
  | "triggerSource"
  | "triggeredByCredentialType",
  AnyPgColumn
>;

function refusedSql(runs: Runs) {
  return sql`(${runs.status} = 'skipped'
  OR (${runs.status} = 'error'
    AND ${runs.errorCategory} IS NOT DISTINCT FROM ${ErrorCategory.BILLING}
    AND ${runs.billable} = false))`;
}

function automatedSql(runs: Runs) {
  return sql`(${runs.triggerSource} IS DISTINCT FROM 'manual'
  OR ${runs.triggeredByCredentialType} <> 'session')`;
}

/** Refused before it started (plan limit, unpaid, not runnable): neither a run nor a failure. */
export const REFUSED_RUN_SQL = refusedSql(workflowExecutions);

/** isAutomatedRun in SQL: a person's run never says a schedule is working. */
export const AUTOMATED_RUN_SQL = automatedSql(workflowExecutions);

/** A refused row spans at most its UTC hour (lib/workflow/refused-runs.ts). */
const REFUSAL_BUCKET_SPAN_MS = 60 * 60 * 1000;

/** A refused row (one per workflow, reason and hour): refusedAt is its newest refusal, refusals how many it holds. */
export type RefusedRun = {
  id: string;
  error: string | null;
  errorCategory: string | null;
  startedAt: Date;
  refusedAt: Date;
  refusals: number;
};

/** When an attempt happened: a refused row's newest refusal, else its start. */
const ATTEMPT_AT_SQL = sql<Date>`CASE WHEN ${REFUSED_RUN_SQL}
  THEN coalesce(${workflowExecutions.completedAt}, ${workflowExecutions.startedAt})
  ELSE ${workflowExecutions.startedAt} END`;

const acceptedRun = alias(workflowExecutions, "accepted_run");
/** The outer row, named in full: select lists render bare column names, which the subquery would rebind. */
const outer = (column: string) => sql.raw(`"workflow_executions"."${column}"`);

/** An accepted run (latestRunSince's kind) between a refused row's first and newest refusal. */
const SPANS_ACCEPTED_SQL = sql`EXISTS (SELECT 1 FROM ${workflowExecutions} AS ${sql.identifier("accepted_run")}
  WHERE ${acceptedRun.workflowId} = ${outer("workflow_id")}
    AND ${acceptedRun.startedAt} > ${outer("started_at")}
    AND ${acceptedRun.startedAt} < coalesce(${outer("completed_at")}, ${outer("started_at")})
    AND ${acceptedRun.deletedAt} IS NULL
    AND ${automatedSql(acceptedRun)}
    AND NOT ${refusedSql(acceptedRun)})`;

/** Refusals a row stands for: one if an accepted run split it (only the later one counts); old rows hold one. */
const REFUSALS_SQL = sql<number>`CASE WHEN ${SPANS_ACCEPTED_SQL} THEN 1
  ELSE greatest(coalesce((${workflowExecutions.output}->>'refusals')::int, 1), 1) END`;

/** Finished automated attempts, platform errors and expired signals left out. */
function attemptConditions(workflowId: string, since: Date | null) {
  return and(
    eq(workflowExecutions.workflowId, workflowId),
    isNotNull(workflowExecutions.completedAt),
    isNull(workflowExecutions.deletedAt),
    AUTOMATED_RUN_SQL,
    sql`${workflowExecutions.status} NOT IN ('phantom', 'system_error')`,
    sql`(${workflowExecutions.status} <> 'error'
      OR ${workflowExecutions.errorType} IS DISTINCT FROM ${ExecutionErrorType.SYSTEM})`,
    // A skip with no category (an expired Pyth signal) was never an attempt.
    sql`(${workflowExecutions.status} <> 'skipped' OR ${workflowExecutions.errorCategory} IS NOT NULL)`,
    since
      ? sql`${ATTEMPT_AT_SQL} >= ${sql.param(since, workflowExecutions.startedAt)}`
      : undefined,
    // Index bound: a row's attempt time is under an hour after its start.
    since ? gte(workflowExecutions.startedAt, beforeBucket(since)) : undefined
  );
}

/** The earliest start of a row whose attempt time is `at` or later. */
export function beforeBucket(at: Date): Date {
  return new Date(at.getTime() - REFUSAL_BUCKET_SPAN_MS);
}

// The newest `count` by start (index order) all happened at or after the count-th
// start; a row starting over an hour before it happened before all of them.
async function attemptWindowStart(
  workflowId: string,
  count: number,
  since: Date | null
): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: workflowExecutions.startedAt })
    .from(workflowExecutions)
    .where(attemptConditions(workflowId, since))
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(count);
  const oldest = rows.at(-1);
  return rows.length === count && oldest
    ? beforeBucket(oldest.startedAt)
    : since;
}

/**
 * Its newest attempts, newest first, when they were all refused and hold at
 * least `events` refusals between them; else null.
 */
export async function loadRefusalStreak(
  workflowId: string,
  events: number,
  since: Date | null
): Promise<RefusedRun[] | null> {
  // Each row holds at least one refusal, so `events` rows always suffice.
  const windowStart = await attemptWindowStart(workflowId, events, since);
  const rows = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      error: workflowExecutions.error,
      errorCategory: workflowExecutions.errorCategory,
      billable: workflowExecutions.billable,
      startedAt: workflowExecutions.startedAt,
      refusedAt: ATTEMPT_AT_SQL.mapWith(workflowExecutions.startedAt),
      refusals: REFUSALS_SQL.mapWith(Number),
    })
    .from(workflowExecutions)
    .where(
      and(
        attemptConditions(workflowId, since),
        windowStart ? gte(workflowExecutions.startedAt, windowStart) : undefined
      )
    )
    .orderBy(desc(ATTEMPT_AT_SQL), desc(workflowExecutions.id))
    .limit(events);
  const streak: RefusedRun[] = [];
  let total = 0;
  for (const row of rows) {
    if (!isRefusedRun(row)) {
      return null;
    }
    streak.push({
      id: row.id,
      error: row.error,
      errorCategory: row.errorCategory,
      startedAt: row.startedAt,
      refusedAt: row.refusedAt,
      refusals: row.refusals,
    });
    total += row.refusals;
    if (total >= events) {
      return streak;
    }
  }
  return null;
}

/** Its newest refused attempt from `since` on, whatever came after it. */
export async function loadNewestRefusal(
  workflowId: string,
  since: Date
): Promise<RefusedRun | null> {
  const [row] = await db
    .select({
      id: workflowExecutions.id,
      error: workflowExecutions.error,
      errorCategory: workflowExecutions.errorCategory,
      startedAt: workflowExecutions.startedAt,
      refusedAt: ATTEMPT_AT_SQL.mapWith(workflowExecutions.startedAt),
      refusals: REFUSALS_SQL.mapWith(Number),
    })
    .from(workflowExecutions)
    .where(and(attemptConditions(workflowId, since), REFUSED_RUN_SQL))
    .orderBy(desc(ATTEMPT_AT_SQL), desc(workflowExecutions.id))
    .limit(1);
  return row ?? null;
}

/** Newest finished runs, without platform errors or refusals (summarizeStreak steps over them too). */
export async function loadStreakRuns(
  workflowId: string,
  limit: number
): Promise<StreakRun[]> {
  return await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      triggerSource: workflowExecutions.triggerSource,
      credentialType: workflowExecutions.triggeredByCredentialType,
      startedAt: workflowExecutions.startedAt,
      completedAt: workflowExecutions.completedAt,
      error: workflowExecutions.error,
      errorType: workflowExecutions.errorType,
      errorCategory: workflowExecutions.errorCategory,
      billable: workflowExecutions.billable,
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        isNotNull(workflowExecutions.completedAt),
        isNull(workflowExecutions.deletedAt),
        sql`(${workflowExecutions.status} <> 'error'
          OR ${workflowExecutions.errorType} IS DISTINCT FROM ${ExecutionErrorType.SYSTEM})`,
        sql`NOT ${REFUSED_RUN_SQL}`
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(limit);
}
