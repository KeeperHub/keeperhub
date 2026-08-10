import { CronExpressionParser } from "cron-parser";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  workflowExecutions,
  workflowSchedules,
  type workflows,
} from "../../lib/db/schema";
import {
  classifyExecutionError,
  isDefaultClassification,
} from "../../lib/errors/classify";
import type { ErrorCode } from "../../lib/errors/error-codes";
import {
  isErrorStatus,
  statusForErrorType,
} from "../../lib/errors/execution-status";
import { calculateTotalSteps } from "../../lib/workflow/executor/progress";
import type { WorkflowEdge, WorkflowNode } from "../../lib/workflow/store";
import type { executeWorkflow } from "../../lib/workflow/executor/executor.workflow";
import { toJsonSafe } from "./serialize";
import { recordTerminalSample } from "./terminal-counters";

export type DbSchema = {
  workflows: typeof workflows;
  workflowExecutions: typeof workflowExecutions;
  workflowSchedules: typeof workflowSchedules;
};

/**
 * Result of a gated status compare-and-set claim on an execution row:
 * - "claimed":          the CAS won (this delivery owns the dispatch).
 * - "already_advanced": a row exists but is no longer in the claimable status
 *                       (a prior/duplicate SQS delivery already claimed it, or
 *                       it is running/terminal) - the caller must NOT re-run.
 * - "not_found":        no row with this id exists.
 */
export type ClaimOutcome = "claimed" | "already_advanced" | "not_found";

/**
 * Reaper error codes that mark a row `system_error` WITHOUT it ever having
 * dispatched: P-0005 (phantom never picked up) and P-0001 (pending timed out,
 * and the reaper only assigns it when there are NO step logs). A row in either
 * state provably produced no side effects, so a message redelivered after a
 * concurrency-requeue whose row was reaped in the meantime can safely RE-CLAIM
 * and re-run it rather than be dropped as a duplicate - which restores the
 * RequeueSignal "retry later" intent. Any other terminal/advanced state
 * (running, success, error, cancelled, or system_error from a dispatch/run
 * failure: E-0001/P-0004/E-0004) means work may have started and is dropped.
 */
const REAPED_NEVER_RAN_CODES: ErrorCode[] = ["P-0001", "P-0005"];

// The execution-start CAS UPDATE runs on the hot dispatch path. A
// transient DB error there (dropped connection, statement timeout under the
// top-of-minute load spike) would otherwise propagate to the processMessage
// backstop, which promotes it to a terminal system_error and deletes the SQS
// message - a sub-second blip becomes an alerting failure with no redelivery.
// Retrying the idempotent CAS a couple of times with short backoff lets that
// blip resolve and the execution proceed normally.
const CLAIM_MAX_ATTEMPTS = 3; // initial attempt + 2 retries
const CLAIM_BACKOFF_BASE_MS = 50;
const CLAIM_BACKOFF_MAX_MS = 400;
const CLAIM_BACKOFF_JITTER_MS = 50;

// Driver/socket error codes and SQLSTATEs that signal a transient connection or
// contention failure worth retrying. Anything else (a real bug, a constraint
// violation) re-throws immediately so it surfaces fast rather than being masked
// by a retry loop.
const TRANSIENT_DB_ERROR_CODES: ReadonlySet<string> = new Set([
  // postgres.js connection-lifecycle errors
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_CONNECT_TIMEOUT",
  "CONNECT_TIMEOUT",
  // node socket errors
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  // SQLSTATE class 08 - connection exception
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  // SQLSTATE - admin shutdown / crash / too many connections
  "57P01",
  "57P02",
  "57P03",
  "53300",
  // SQLSTATE - serialization failure / deadlock
  "40001",
  "40P01",
]);

function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_DB_ERROR_CODES.has(code);
}

function claimBackoffMs(attempt: number): number {
  const exponential = CLAIM_BACKOFF_BASE_MS * 2 ** attempt;
  const capped = Math.min(exponential, CLAIM_BACKOFF_MAX_MS);
  return capped + Math.floor(Math.random() * CLAIM_BACKOFF_JITTER_MS);
}

/**
 * Run a claim CAS UPDATE, retrying a transient connection/contention error a
 * bounded number of times with short backoff. A non-transient error re-throws
 * immediately; a transient error that outlives every attempt re-throws so the
 * processMessage backstop still fails the execution (a genuinely-down DB is a
 * real system error). The CAS is idempotent under its gated WHERE, so a retry is
 * safe: if a prior attempt committed before the connection dropped, the row has
 * already advanced and the retry simply matches zero rows (the caller then reads
 * it as already_advanced and drops the duplicate).
 */
async function runClaimWithRetry<T>(
  op: () => PromiseLike<T[]>,
  executionId: string
): Promise<T[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === CLAIM_MAX_ATTEMPTS - 1) {
        throw error;
      }
      const backoff = claimBackoffMs(attempt);
      console.warn(
        `[Claim] Transient DB error claiming execution ${executionId} (attempt ${attempt + 1}/${CLAIM_MAX_ATTEMPTS}), retrying in ${backoff}ms:`,
        error
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw lastError;
}

/**
 * After a gated CAS matched zero rows, disambiguate "row exists but not in the
 * expected status" from "no such row" with a single point lookup on the id PK.
 */
async function classifyClaimMiss(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string
): Promise<"already_advanced" | "not_found"> {
  const existing = await db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  return existing.length > 0 ? "already_advanced" : "not_found";
}

export async function updateExecutionStatus(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  status: "running" | "success" | "error" | "cancelled",
  result?: { output?: unknown; error?: string }
): Promise<void> {
  // Classify the failure so the backstop row carries error_category /
  // error_type / error_code, exactly like the engine's own finalize
  // (logWorkflowCompleteDb). Without this, executions the executor closes on
  // its own (consumer-crash backstop, SIGTERM shutdown, engine-write-lost)
  // land with a NULL classification and drop out of error_type-filtered
  // dashboards even though recordTerminalSample already counts them.
  const classification =
    status === "error" ? classifyExecutionError(result?.error) : null;

  // Mirror logWorkflowCompleteDb: a confidently system-classified failure
  // persists as system_error so it stays filterable apart from user/workflow
  // errors; an unmatched failure that only defaulted to "system" keeps the
  // plain "error" status (its error_type is still written as "system"). The
  // engine and this backstop must produce the same row shape for the same
  // failure so a lost engine write is closed identically.
  const persistedStatus =
    status === "error"
      ? statusForErrorType(
          classification && !isDefaultClassification(classification)
            ? classification.errorType
            : null
        )
      : status;

  const isTerminal =
    persistedStatus === "success" || isErrorStatus(persistedStatus);

  const updateData: Record<string, unknown> = {
    status: persistedStatus,
    updatedAt: new Date(),
  };

  if (isTerminal) {
    updateData.completedAt = new Date();
  }
  if (result?.output !== undefined) {
    updateData.output = toJsonSafe(result.output);
  }
  if (result?.error) {
    updateData.error = result.error;
  }
  if (classification) {
    updateData.errorCategory = classification.errorCategory;
    updateData.errorType = classification.errorType;
    updateData.errorCode = classification.code;
  }

  // Only transition a row that has not already reached a terminal state. The
  // workflow engine (logWorkflowCompleteDb, via triggerStep _workflowComplete)
  // is the authoritative writer of the final status - including its
  // error->success reconciliation - and runs from inside executeWorkflow. The
  // runner/in-process callers re-issue success/error through here as a
  // backstop: if the engine's own write landed, the row is already
  // success/error/cancelled and this update is a no-op; if that write was lost
  // (it can throw and only be logged), this closes the row instead of leaving
  // it stuck "running". Excluding all three terminal states keeps the backstop
  // from clobbering the engine's richer fields (KEEP-431).
  const updated = await db
    .update(workflowExecutions)
    .set(updateData)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        ne(workflowExecutions.status, "success"),
        ne(workflowExecutions.status, "error"),
        ne(workflowExecutions.status, "system_error"),
        ne(workflowExecutions.status, "cancelled")
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });

  // A matched row means the engine's own terminal write was lost (the CAS
  // above excludes every terminal state), so this backstop is the execution's
  // first and only terminal transition and must emit the terminal counters
  // the engine would have emitted. Cancellation is intentionally not counted
  // (the finished counter tracks success/error outcomes only). Pass the
  // classification we persisted so the counter labels are guaranteed to match
  // the row's error_type / error_category.
  if (
    updated.length > 0 &&
    (persistedStatus === "success" || isErrorStatus(persistedStatus))
  ) {
    await recordTerminalSample(db, {
      workflowId: updated[0].workflowId,
      status: persistedStatus,
      errorMessage: result?.error,
      errorType: classification?.errorType,
      errorCategory: classification?.errorCategory,
    });
  }
}

/**
 * KEEP-853: mark an in-flight row system_error right away instead of leaving it
 * for the reaper (which runs minutes later). Compare-and-set on the caller's
 * expected status(es) - defaulting to ('phantom','pending') for the
 * processMessage backstop - so it never clobbers a row the runtime already
 * advanced past. The dispatch-failure guards pass their own single expected
 * status (e.g. 'pending' or 'running') and errorCode.
 *
 * Returns true when a row was marked, false when the CAS matched nothing (no
 * executionId, or the row was not in an expected status). The caller surfaces
 * the false case instead of treating the backstop as resolved, since such a row
 * is left for the reaper rather than marked immediately.
 */
export async function failExecutionAsSystemError(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined,
  fields: {
    error: string;
    errorCode: ErrorCode;
    statuses?: ("phantom" | "pending" | "running")[];
  }
): Promise<boolean> {
  if (!executionId) {
    return false;
  }
  const marked = await db
    .update(workflowExecutions)
    .set({
      status: "system_error",
      error: fields.error,
      errorCode: fields.errorCode,
      errorType: "system",
      errorCategory: "infrastructure",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(
          workflowExecutions.status,
          fields.statuses ?? ["phantom", "pending"]
        )
      )
    )
    .returning({
      id: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
    });

  // The phantom/pending CAS means a match is the row's first terminal
  // transition; these rows never reach logWorkflowCompleteDb or the reaper,
  // so this is their only chance to be counted.
  if (marked.length > 0) {
    await recordTerminalSample(db, {
      workflowId: marked[0].workflowId,
      status: "system_error",
      errorMessage: fields.error,
      errorType: "system",
      errorCategory: "infrastructure",
    });
  }
  return marked.length > 0;
}

/**
 * Claim a pre-created 'phantom' execution row for a schedule/block/event run:
 * compare-and-set 'phantom' -> 'pending' and stamp its input.
 *
 * The scheduler/event-tracker pre-creates a 'phantom' row and passes its id on
 * the SQS message. The CAS makes the claim exactly-once: only the first delivery
 * wins ("claimed"). A duplicate delivery whose row was already claimed/advanced
 * returns "already_advanced" and MUST be dropped by the caller - re-running would
 * send a second, fund-moving execution (there is no downstream dedup).
 * "not_found" is a message whose phantom was discarded or never persisted; also
 * dropped for an id-bearing message.
 *
 * The CAS also matches a reaped-never-ran row (system_error with a
 * REAPED_NEVER_RAN_CODES errorCode) so a concurrency-requeued message whose
 * phantom the reaper marked in the meantime is re-claimed and re-run rather than
 * dropped - a run that provably never dispatched, so re-running is side-effect-safe.
 */
export async function claimPhantomForExecution(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  input: Record<string, unknown>,
  executedWorkflowHash: string
): Promise<ClaimOutcome> {
  const result = await runClaimWithRetry(
    () =>
      db
        .update(workflowExecutions)
        // The phantom was created billable=false (it had not run yet); claiming
        // it means it is now a real execution, so it becomes billable like any
        // owner-initiated run. Stamp the hash of the definition the executor
        // just loaded so the run links to its workflow_history version. Clear
        // any reaper stamp when re-claiming a reaped-never-ran row.
        .set({
          status: "pending",
          input,
          billable: true,
          executedWorkflowHash,
          error: null,
          errorCode: null,
          completedAt: null,
        })
        .where(
          and(
            eq(workflowExecutions.id, executionId),
            or(
              eq(workflowExecutions.status, "phantom"),
              and(
                eq(workflowExecutions.status, "system_error"),
                inArray(workflowExecutions.errorCode, REAPED_NEVER_RAN_CODES)
              )
            )
          )
        )
        .returning({ id: workflowExecutions.id }),
    executionId
  );
  if (result.length > 0) {
    return "claimed";
  }
  return classifyClaimMiss(db, executionId);
}

/**
 * Claim a pre-created 'pending' execution row for a manual/webhook run:
 * compare-and-set 'pending' -> 'running'. The app pre-creates the row as
 * 'pending' before enqueueing, so unlike schedule/block/event there is no
 * phantom to upgrade; this CAS is what makes the consume exactly-once. Only the
 * first delivery wins ("claimed"); a duplicate whose row already advanced
 * returns "already_advanced" and MUST be dropped. The runner's own later
 * 'running' write is then an idempotent no-op. Like claimPhantomForExecution,
 * the CAS also re-claims a reaped-never-ran row (system_error with a
 * REAPED_NEVER_RAN_CODES errorCode).
 */
export async function claimPendingForExecution(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string
): Promise<ClaimOutcome> {
  const result = await runClaimWithRetry(
    () =>
      db
        .update(workflowExecutions)
        // Clear any reaper stamp when re-claiming a reaped-never-ran row.
        .set({
          status: "running",
          error: null,
          errorCode: null,
          completedAt: null,
        })
        .where(
          and(
            eq(workflowExecutions.id, executionId),
            or(
              eq(workflowExecutions.status, "pending"),
              and(
                eq(workflowExecutions.status, "system_error"),
                inArray(workflowExecutions.errorCode, REAPED_NEVER_RAN_CODES)
              )
            )
          )
        )
        .returning({ id: workflowExecutions.id }),
    executionId
  );
  if (result.length > 0) {
    return "claimed";
  }
  return classifyClaimMiss(db, executionId);
}

/**
 * KEEP-693: delete a pre-created phantom or pending row when the executor
 * intentionally skips the trigger (workflow not found / not executable /
 * schedule invalid). The trigger correctly did not run, so there is no failure
 * to surface and the reaper must not later age the orphan to a system P-code.
 * The compare-and-set on status IN ('phantom', 'pending') makes it a no-op
 * when there is no id or the row already advanced past these states.
 *
 * Matches 'pending' in addition to 'phantom' because manual-trigger executions
 * are pre-created by the API as 'pending' before being enqueued.
 */
export async function discardPhantomRow(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined
): Promise<void> {
  if (!executionId) {
    return;
  }
  await db
    .delete(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, ["phantom", "pending"])
      )
    );
}

/**
 * KEEP-693: resolve a pre-created phantom or pending row to a user-actionable
 * error (e.g. a billing block) rather than leaving it for the reaper to
 * mis-code as a system failure. Compare-and-set on status IN ('phantom',
 * 'pending') so a row that already advanced is left untouched.
 *
 * Matches 'pending' in addition to 'phantom' because manual-trigger executions
 * are pre-created by the API as 'pending' (not 'phantom') before being enqueued.
 */
export async function resolvePhantomToError(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined,
  fields: { error: string; errorCategory: "billing"; errorType: "user" }
): Promise<void> {
  if (!executionId) {
    return;
  }
  const resolved = await db
    .update(workflowExecutions)
    .set({
      status: "error",
      error: fields.error,
      errorCategory: fields.errorCategory,
      errorType: fields.errorType,
      // The run was blocked before it started, so it consumes no quota. The
      // claim flips billable to true up front; undo that here or a blocked
      // org's retries keep inflating its plan-usage ratio past 100%.
      billable: false,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, ["phantom", "pending"])
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });

  // Same reasoning as failExecutionAsSystemError: the phantom/pending CAS
  // makes a match the first terminal transition, and billing-blocked rows
  // never reach any other counted finalize path.
  if (resolved.length > 0) {
    await recordTerminalSample(db, {
      workflowId: resolved[0].workflowId,
      status: "error",
      errorMessage: fields.error,
      errorType: fields.errorType,
      errorCategory: fields.errorCategory,
    });
  }
}

export async function initializeExecutionProgress(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): Promise<void> {
  const totalSteps = calculateTotalSteps(nodes, edges);
  await db
    .update(workflowExecutions)
    .set({
      totalSteps: totalSteps.toString(),
      completedSteps: "0",
      executionTrace: [],
      currentNodeId: null,
      currentNodeName: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    })
    .where(eq(workflowExecutions.id, executionId));
}

type ExecuteWorkflowResult = Awaited<ReturnType<typeof executeWorkflow>>;

/**
 * Write the terminal execution status (success or error) and optionally update
 * the associated schedule row. Replaces the identical if/else block that
 * workflow-runner.ts and in-process.ts both maintained after executeWorkflow().
 *
 * Returns the error message string on failure (null on success) so callers can
 * use it for their own logging without re-deriving it.
 */
export async function applyExecutionResult(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  result: ExecuteWorkflowResult,
  opts: { scheduleId?: string }
): Promise<{ errorMessage: string | null }> {
  if (result.success) {
    await updateExecutionStatus(db, executionId, "success", {
      output: result.outputs,
    });
    if (opts.scheduleId) {
      await updateScheduleStatus(db, opts.scheduleId, "success");
    }
    return { errorMessage: null };
  }

  const errorMessage =
    result.error ||
    Object.values(result.results || {}).find((r) => !r.success)?.error ||
    "Unknown error";

  await updateExecutionStatus(db, executionId, "error", {
    error: errorMessage,
    output: result.outputs,
  });
  if (opts.scheduleId) {
    await updateScheduleStatus(db, opts.scheduleId, "error", errorMessage);
  }
  return { errorMessage };
}

export function computeNextRunTime(
  cronExpression: string,
  timezone: string
): Date | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: timezone,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * KEEP-575: next interval fire time = first `anchor + k * intervalSeconds`
 * with k >= 1 and the value strictly greater than `now`. First fire is
 * `anchor + 1 * interval` (not the anchor itself). Mirrors
 * lib/schedule-service.ts so the executor's lastRunAt-update path stays
 * consistent with the dispatcher.
 */
export function computeNextIntervalRunTime(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date = new Date()
): Date {
  // KEEP-575: throw on garbage inputs rather than silently writing
  // Invalid Date to workflow_schedules.next_run_at. Mirrors the
  // lib/schedule-service.ts guard so the executor and the app stay
  // consistent.
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error(
      `computeNextIntervalRunTime: invalid intervalSeconds ${String(intervalSeconds)}`
    );
  }
  const anchorMs = anchorAt.getTime();
  if (!Number.isFinite(anchorMs)) {
    throw new Error(
      "computeNextIntervalRunTime: invalid anchorAt (getTime returned NaN)"
    );
  }
  const intervalMs = intervalSeconds * 1000;
  const nowMs = now.getTime();
  const firstFireMs = anchorMs + intervalMs;
  if (nowMs < firstFireMs) {
    return new Date(firstFireMs);
  }
  const elapsedMs = nowMs - anchorMs;
  const kNext = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(anchorMs + kNext * intervalMs);
}

export async function updateScheduleStatus(
  db: PostgresJsDatabase<DbSchema>,
  scheduleId: string,
  status: "success" | "error",
  error?: string
): Promise<void> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    return;
  }

  // KEEP-575: strict !== checks so a stray zero/null in either column
  // can't silently demote the row to the cron path.
  const intervalSeconds = schedule.intervalSeconds;
  const anchorAt = schedule.anchorAt;
  const isInterval =
    intervalSeconds !== null &&
    intervalSeconds > 0 &&
    anchorAt !== null &&
    anchorAt !== undefined;
  const nextRunAt = isInterval
    ? computeNextIntervalRunTime(intervalSeconds, anchorAt)
    : computeNextRunTime(schedule.cronExpression, schedule.timezone);

  const runCount =
    status === "success"
      ? String(Number(schedule.runCount || "0") + 1)
      : schedule.runCount;

  await db
    .update(workflowSchedules)
    .set({
      lastRunAt: new Date(),
      lastStatus: status,
      lastError: status === "error" ? error : null,
      nextRunAt,
      runCount,
      updatedAt: new Date(),
    })
    .where(eq(workflowSchedules.id, scheduleId));
}
