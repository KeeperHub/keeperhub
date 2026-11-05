import "server-only";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { StreakRun } from "./streak";

/** Refused before it started (plan limit, unpaid, not runnable): neither a run nor a failure. */
export const REFUSED_RUN_SQL = sql`(${workflowExecutions.status} = 'skipped'
  OR (${workflowExecutions.status} = 'error'
    AND ${workflowExecutions.errorCategory} IS NOT DISTINCT FROM 'billing'
    AND ${workflowExecutions.billable} = false))`;

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
