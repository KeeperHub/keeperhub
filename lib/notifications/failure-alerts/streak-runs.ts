import "server-only";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { StreakRun } from "./streak";

/** Newest finished runs, without our own platform errors (summarizeStreak steps over them too). */
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
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        isNotNull(workflowExecutions.completedAt),
        isNull(workflowExecutions.deletedAt),
        sql`(${workflowExecutions.status} <> 'error'
          OR ${workflowExecutions.errorType} IS DISTINCT FROM ${ExecutionErrorType.SYSTEM})`
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(limit);
}
