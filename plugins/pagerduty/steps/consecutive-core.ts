/**
 * "Page only after N consecutive runs" - the flap guard for the trigger
 * action.
 *
 * IMPORTANT: this file must NOT contain "use step".
 *
 * The streak is derived from run history rather than kept in a counter of its
 * own: a run that reached this node is a run where the branch leading to it
 * was taken, which is exactly the condition the user wants counted. A run that
 * finished successfully without reaching the node breaks the streak, so one
 * healthy check clears it. A run that failed, was cancelled, or was refused
 * before it started is stepped over rather than counted either way - see
 * CONCLUSIVE_STATUSES. No new table, and the history a user can already see is
 * the source of truth.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";

export const MIN_CONSECUTIVE_RUNS = 1;
export const MAX_CONSECUTIVE_RUNS = 20;

/**
 * Parse the configured threshold. The editor sends strings and MCP callers
 * send numbers; anything unparseable means "page immediately" rather than an
 * error, so a stale config can never silence an alert.
 */
export function resolveConsecutiveRuns(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return MIN_CONSECUTIVE_RUNS;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return MIN_CONSECUTIVE_RUNS;
  }
  return Math.min(
    Math.max(MIN_CONSECUTIVE_RUNS, Math.trunc(value)),
    MAX_CONSECUTIVE_RUNS
  );
}

export type ConsecutiveContext = {
  workflowId?: string;
  nodeId?: string;
  executionId?: string;
};

/**
 * How many runs in a row, ending with this one, reached this node. Returns 1
 * when there is nothing to count against: a threshold of 1, a missing
 * identifier, or a database that will not answer. Failing open matters more
 * than the guard here - an alerting node that goes quiet because a count query
 * failed is the worst outcome available.
 */
export async function countConsecutiveRuns(
  context: ConsecutiveContext,
  threshold: number
): Promise<number> {
  if (threshold <= MIN_CONSECUTIVE_RUNS) {
    return 1;
  }
  const { workflowId, nodeId, executionId } = context;
  if (!(workflowId && nodeId)) {
    return 1;
  }

  try {
    return await queryStreak(workflowId, nodeId, executionId, threshold);
  } catch (error) {
    // Fail open, loudly. The database is least healthy exactly when an
    // incident is in progress, and a page held back because a count query
    // timed out is the failure this whole feature exists to prevent.
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[PagerDuty] Could not count consecutive runs, paging anyway",
      error,
      { plugin_name: "pagerduty", workflow_id: workflowId }
    );
    return threshold;
  }
}

/**
 * How far back to look for the runs that count.
 *
 * Only a run that finished successfully can end a streak, so runs that failed
 * or never started are stepped over and a window of exactly threshold-1 rows
 * would come up short as soon as one appears. Four times the threshold, with a
 * floor, covers a bad patch without turning this into an unbounded scan; if
 * every row in the window is inconclusive the count simply stays where the
 * evidence puts it, which errs towards paging.
 */
const STREAK_WINDOW_MULTIPLIER = 4;
const MIN_STREAK_WINDOW = 10;

/**
 * Runs that say the condition cleared.
 *
 * A run that did not reach this node only proves the branch was not taken if
 * the run actually got far enough to decide. A run that errored upstream, was
 * refused before it started (`skipped`), was cancelled, or died on the
 * platform's side says nothing about the condition - and during the outage
 * this node exists to page for, those are exactly the runs that appear.
 * Counting them as "the check passed" resets the streak on every other run and
 * holds the page for as long as the outage lasts, which is the one failure
 * this whole feature is supposed to prevent.
 */
const CONCLUSIVE_STATUSES = ["success"] as const;

async function queryStreak(
  workflowId: string,
  nodeId: string,
  executionId: string | undefined,
  threshold: number
): Promise<number> {
  const startedBefore = await currentRunStartedAt(executionId);
  const window = Math.max(
    MIN_STREAK_WINDOW,
    (threshold - 1) * STREAK_WINDOW_MULTIPLIER
  );

  const priorRuns = await db
    .select({ id: workflowExecutions.id, status: workflowExecutions.status })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        // Only runs that started before this one, and only ones that have
        // finished. A sibling run that overlaps this one has not reached this
        // node yet, and counting it would break the streak on every run of a
        // workflow whose schedule overlaps - holding the page forever.
        lt(workflowExecutions.startedAt, startedBefore),
        isNotNull(workflowExecutions.completedAt),
        // Purging run history soft-deletes executions and their logs together.
        // Filtering one and not the other would count a purged run as a run
        // that skipped this node, and reset the streak.
        isNull(workflowExecutions.deletedAt)
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(window);

  if (priorRuns.length === 0) {
    return 1;
  }

  const priorIds = priorRuns.map((run) => run.id);
  const reachedRows = await db
    .select({ executionId: workflowExecutionLogs.executionId })
    .from(workflowExecutionLogs)
    .where(
      and(
        inArray(workflowExecutionLogs.executionId, priorIds),
        eq(workflowExecutionLogs.nodeId, nodeId),
        isNull(workflowExecutionLogs.deletedAt)
      )
    );

  const reached = new Set(reachedRows.map((row) => row.executionId));
  const conclusive: ReadonlySet<string> = new Set(CONCLUSIVE_STATUSES);

  // Walk back from the most recent prior run. A run that reached this node
  // extends the streak; a run that finished successfully without reaching it
  // ends the streak; anything else is stepped over, because it never got to
  // say either way.
  let streak = 1;
  for (const run of priorRuns) {
    if (reached.has(run.id)) {
      streak += 1;
      if (streak >= threshold) {
        break;
      }
      continue;
    }
    if (conclusive.has(run.status)) {
      break;
    }
  }
  return streak;
}

/**
 * When this run started. Anything that started later is a concurrent run, not
 * a prior one. Falls back to now for a step running outside a recorded
 * execution (a node test), which counts every finished run before this moment.
 */
async function currentRunStartedAt(
  executionId: string | undefined
): Promise<Date> {
  if (!executionId) {
    return new Date();
  }
  const [row] = await db
    .select({ startedAt: workflowExecutions.startedAt })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  return row?.startedAt ?? new Date();
}
