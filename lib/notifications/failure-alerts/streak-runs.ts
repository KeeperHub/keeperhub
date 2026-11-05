import "server-only";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory } from "@/lib/logging";
import { isRefusedRun, type StreakRun } from "./streak";

/** Refused before it started (plan limit, unpaid, not runnable): neither a run nor a failure. */
export const REFUSED_RUN_SQL = sql`(${workflowExecutions.status} = 'skipped'
  OR (${workflowExecutions.status} = 'error'
    AND ${workflowExecutions.errorCategory} IS NOT DISTINCT FROM ${ErrorCategory.BILLING}
    AND ${workflowExecutions.billable} = false))`;

/** isAutomatedRun in SQL: a person's run never says a schedule is working. */
export const AUTOMATED_RUN_SQL = sql`(${workflowExecutions.triggerSource} IS DISTINCT FROM 'manual'
  OR ${workflowExecutions.triggeredByCredentialType} <> 'session')`;

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

/** Refusals a row stands for; rows written before the hourly bucket hold one. */
const REFUSALS_SQL = sql<number>`greatest(coalesce((${workflowExecutions.output}->>'refusals')::int, 1), 1)`;

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
      : undefined
  );
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
    .where(attemptConditions(workflowId, since))
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

/** Its newest refused attempt, whatever came after it. */
export async function loadNewestRefusal(
  workflowId: string
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
    .where(and(attemptConditions(workflowId, null), REFUSED_RUN_SQL))
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
