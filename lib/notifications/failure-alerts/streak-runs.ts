import "server-only";

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
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

export type RefusedRun = { id: string; error: string | null; startedAt: Date };

/** Its newest `count` finished automated attempts, newest first, when every one was refused; else null. */
export async function loadRefusalStreak(
  workflowId: string,
  count: number,
  since: Date | null
): Promise<RefusedRun[] | null> {
  const rows = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      error: workflowExecutions.error,
      errorCategory: workflowExecutions.errorCategory,
      billable: workflowExecutions.billable,
      startedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        isNotNull(workflowExecutions.completedAt),
        isNull(workflowExecutions.deletedAt),
        AUTOMATED_RUN_SQL,
        sql`${workflowExecutions.status} NOT IN ('phantom', 'system_error')`,
        sql`(${workflowExecutions.status} <> 'error'
          OR ${workflowExecutions.errorType} IS DISTINCT FROM ${ExecutionErrorType.SYSTEM})`,
        // A skip with no category (an expired Pyth signal) was never an attempt.
        sql`(${workflowExecutions.status} <> 'skipped' OR ${workflowExecutions.errorCategory} IS NOT NULL)`,
        since ? gte(workflowExecutions.startedAt, since) : undefined
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(count);
  if (rows.length < count || !rows.every(isRefusedRun)) {
    return null;
  }
  return rows.map(({ id, error, startedAt }) => ({ id, error, startedAt }));
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
