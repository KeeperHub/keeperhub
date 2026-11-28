import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
import {
  BUNDLE_STEP_ACTION_TYPES,
  RUN_OUTCOME_OUTPUT,
  SKIP_REASON,
  type SkipReason,
} from "./run-outcome-keys";

/** A waiting run's Not before, its first allowed block, the latest block it read and Send ahead. */
export type WaitingRunInfo = {
  notBefore: number | null;
  firstAllowedBlock: number | null;
  latestBlock: number | null;
  sendAheadBlocks: number | null;
};

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The waiting outputs of each run Skipped because a bundle step waited for Not
 * before (its latest waiting step), by run id. One query for the whole page;
 * only those runs' Write Contract logs are read.
 */
export async function loadWaitingRunInfo(
  runs: readonly { id: string; skipReason: SkipReason | null }[]
): Promise<Map<string, WaitingRunInfo>> {
  const ids = runs
    .filter((run) => run.skipReason === SKIP_REASON.bundleWaiting)
    .map((run) => run.id);
  const found = new Map<string, WaitingRunInfo>();
  if (ids.length === 0) {
    return found;
  }
  const route = RUN_OUTCOME_OUTPUT.routeKey;
  const rows = await db
    .select({
      executionId: workflowExecutionLogs.executionId,
      notBefore: sql<unknown>`${workflowExecutionLogs.outputRaw}->'notBefore'`,
      firstAllowedBlock: sql<unknown>`${workflowExecutionLogs.outputRaw}->'firstAllowedBlock'`,
      latestBlock: sql<unknown>`${workflowExecutionLogs.outputRaw}->'latestBlock'`,
      sendAheadBlocks: sql<unknown>`${workflowExecutionLogs.outputRaw}->'sendAheadBlocks'`,
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        inArray(workflowExecutionLogs.executionId, ids),
        eq(workflowExecutionLogs.status, "success"),
        inArray(workflowExecutionLogs.nodeType, [...BUNDLE_STEP_ACTION_TYPES]),
        sql`${workflowExecutionLogs.outputRaw}->>${sql.raw(`'${route}'`)} = ${RUN_OUTCOME_OUTPUT.waitingRoute}`
      )
    )
    .orderBy(desc(workflowExecutionLogs.startedAt));
  for (const row of rows) {
    // Newest first: a run's latest waiting step wins.
    if (!found.has(row.executionId)) {
      found.set(row.executionId, {
        notBefore: numberOr(row.notBefore),
        firstAllowedBlock: numberOr(row.firstAllowedBlock),
        latestBlock: numberOr(row.latestBlock),
        sendAheadBlocks: numberOr(row.sendAheadBlocks),
      });
    }
  }
  return found;
}
