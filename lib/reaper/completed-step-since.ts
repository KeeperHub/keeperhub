import { type SQL, sql } from "drizzle-orm";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";

/**
 * A step of the outer workflow_executions row completed after `cutoff`: the run
 * still progresses, so the reaper spares it and skip-if-running counts it live.
 * Correlated on execution_id so it probes idx_exec_logs_execution_id per candidate;
 * a NOT IN over every recent step id sequentially scanned the whole log table.
 */
export function completedStepSince(cutoff: Date): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${workflowExecutionLogs}
    WHERE ${workflowExecutionLogs.executionId} = ${workflowExecutions.id}
      AND ${workflowExecutionLogs.completedAt} > ${sql.param(cutoff, workflowExecutionLogs.completedAt)}
  )`;
}
