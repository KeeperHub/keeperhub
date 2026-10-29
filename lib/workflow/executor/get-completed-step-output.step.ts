import "server-only";

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
import { pollForCompletedOutput } from "@/lib/workflow/executor/poll-for-output";

/**
 * Raw single-row query for a completed success log. Not a step boundary so it
 * can be reused by both the one-shot and polling step bodies.
 */
async function queryCompletedSuccessRow(
  executionId: string,
  nodeId: string
): Promise<{ outputRaw: unknown } | null> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    return tx.query.workflowExecutionLogs.findFirst({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.nodeId, nodeId),
        eq(workflowExecutionLogs.status, "success"),
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId),
        isNotNull(workflowExecutionLogs.outputRaw)
      ),
      orderBy: desc(workflowExecutionLogs.completedAt),
      columns: { outputRaw: true },
    });
  });

  if (!row) {
    return null;
  }

  return { outputRaw: row.outputRaw as unknown };
}

/**
 * True while the node still has a 'running' log row, i.e. an earlier attempt
 * of the step is still executing and its outcome is not yet known.
 */
async function queryStepAttemptInFlight(
  executionId: string,
  nodeId: string
): Promise<boolean> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    return tx.query.workflowExecutionLogs.findFirst({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.nodeId, nodeId),
        eq(workflowExecutionLogs.status, "running"),
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId)
      ),
      columns: { id: true },
    });
  });

  return row !== undefined;
}

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function fetchCompletedStepOutputStep(
  executionId: string,
  nodeId: string
): Promise<{ outputRaw: unknown } | null> {
  "use step";

  return queryCompletedSuccessRow(executionId, nodeId);
}

fetchCompletedStepOutputStep.maxRetries = 1;

/**
 * Fetch the success row for a step that ran inside a For Each iteration.
 * Matches the iteration row exactly (forEachNodeId + iterationIndex) instead
 * of filtering iteration rows out. Used by the body-runner spurious-recovery
 * path so each iteration recovers its own output, not whichever iteration was
 * last to write.
 */
export async function fetchCompletedStepOutputAtIterationStep(
  executionId: string,
  nodeId: string,
  forEachNodeId: string,
  iterationIndex: number
): Promise<{ outputRaw: unknown } | null> {
  "use step";

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    return tx.query.workflowExecutionLogs.findFirst({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.nodeId, nodeId),
        eq(workflowExecutionLogs.forEachNodeId, forEachNodeId),
        eq(workflowExecutionLogs.iterationIndex, iterationIndex),
        eq(workflowExecutionLogs.status, "success"),
        isNotNull(workflowExecutionLogs.outputRaw)
      ),
      orderBy: desc(workflowExecutionLogs.completedAt),
      columns: { outputRaw: true },
    });
  });

  if (!row) {
    return null;
  }

  return { outputRaw: row.outputRaw as unknown };
}

fetchCompletedStepOutputAtIterationStep.maxRetries = 1;

/**
 * Poll `workflow_execution_logs` for a step's recorded success for up to
 * `timeoutMs`. The wait runs INSIDE this step boundary so the workflow body
 * stays deterministic and the result is memoized on replay.
 *
 * Recovers the spurious-max-retries race: the framework re-fires a step after
 * a lost completion event and throws before the step body's success row is
 * committed. The success then lands ~0.3-0.5s later; a one-shot read misses
 * it. Polling here lets the catch handler reconcile instead of nullifying the
 * node and racing convergence ahead with no data.
 *
 * The same throw fires when the queue delivers a step twice while the first
 * attempt is still executing. That attempt's success lands only when it
 * finishes, so while the node still has a 'running' row the poll keeps waiting
 * up to `inFlightTimeoutMs`.
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function awaitCompletedStepOutputStep(
  executionId: string,
  nodeId: string,
  timeoutMs: number,
  intervalMs: number,
  inFlightTimeoutMs?: number
): Promise<{ outputRaw: unknown } | null> {
  "use step";

  return pollForCompletedOutput(
    () => queryCompletedSuccessRow(executionId, nodeId),
    {
      timeoutMs,
      intervalMs,
      extendWhile: () => queryStepAttemptInFlight(executionId, nodeId),
      maxTimeoutMs: inFlightTimeoutMs,
    }
  );
}

awaitCompletedStepOutputStep.maxRetries = 1;

export async function fetchCompletedStepOutputsBatchStep(
  executionId: string,
  nodeIds: string[]
): Promise<Array<{ nodeId: string; outputRaw: unknown }>> {
  "use step";

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    return tx.query.workflowExecutionLogs.findMany({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        inArray(workflowExecutionLogs.nodeId, nodeIds),
        eq(workflowExecutionLogs.status, "success"),
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId),
        isNotNull(workflowExecutionLogs.outputRaw)
      ),
      orderBy: desc(workflowExecutionLogs.completedAt),
      columns: { nodeId: true, outputRaw: true },
    });
  });

  return rows.map((row) => ({
    nodeId: row.nodeId,
    outputRaw: row.outputRaw as unknown,
  }));
}

fetchCompletedStepOutputsBatchStep.maxRetries = 1;
