import { type SQL, sql } from "drizzle-orm";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";

// Distinct steps per run (loop passes count once); the run id is its own sql chunk, else the query drops its alias.
// deleted_at IS NULL mirrors executionLogNotDeleted(), which cannot name the step_logs alias.
export function stepCountExtra(): SQL.Aliased<number> {
  return sql<number>`(SELECT count(DISTINCT step_logs.node_id) FROM ${workflowExecutionLogs} AS step_logs WHERE step_logs.execution_id = ${sql`${workflowExecutions.id}`} AND step_logs.deleted_at IS NULL)::int`.as(
    "step_count"
  );
}
