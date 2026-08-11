import { execFileSync } from "node:child_process";

/**
 * Shared assertion helpers for the on-demand E2E harnesses. These run against a
 * live local stack (app-dev, localstack SQS, redis, executor, Postgres) and read
 * execution state straight from the worktree DB via psql-in-container, since the
 * tracker itself never connects to Postgres. Override the container/db name with
 * E2E_DB_CONTAINER / E2E_DB_NAME.
 */
const CONTAINER = process.env.E2E_DB_CONTAINER ?? "keep-987-db-1";
const DB_NAME = process.env.E2E_DB_NAME ?? "KEEP-987";

function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-d", DB_NAME, "-tAc", sql],
    { encoding: "utf8" },
  ).trim();
}

/** Current status of one execution row (empty string if the row is absent). */
export function executionStatus(id: string): string {
  return psql(`SELECT status FROM workflow_executions WHERE id='${id}'`);
}

/** Count of executor-completed (success) executions for a workflow. */
export function successCount(workflowId: string): number {
  return Number(
    psql(
      `SELECT count(*) FROM workflow_executions WHERE workflow_id='${workflowId}' AND status='success'`,
    ),
  );
}

/**
 * Count of executions the executor has picked up (advanced past the producer's
 * "phantom" placeholder). Rising means the executor consumed the SQS message and
 * started running the workflow - the pipeline claim, independent of whether the
 * workflow's own steps ultimately succeed.
 */
export function advancedCount(workflowId: string): number {
  return Number(
    psql(
      `SELECT count(*) FROM workflow_executions WHERE workflow_id='${workflowId}' AND status <> 'phantom'`,
    ),
  );
}

export async function poll(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
