/**
 * Phantom execution helpers (KEEP-693).
 *
 * Before enqueuing a trigger, the dispatcher pre-creates a 'phantom'
 * workflow_executions row via the internal API so the run is visible even if
 * it never reaches the executor (dispatcher down, SQS lost). The executor
 * upgrades that row to 'pending' on dequeue. If the enqueue itself fails, the
 * dispatcher resolves the phantom to a coded failure so it surfaces in the run
 * logs instead of being aged out generically by the reaper.
 *
 * Both calls are best-effort: a failure to create a phantom degrades to the
 * legacy id-less enqueue (the executor inserts its own row), and a failure to
 * mark a phantom is swallowed (the reaper ages it out as a fallback). Neither
 * must ever block or fail a real trigger, except that a skip-if-running
 * dispatch whose phantom fails is skipped rather than run unchecked.
 */

import { ApiError, apiRequest, apiRequestWithAttempts } from "./http-client.js";

/** Trigger sources the scheduler reports for phantom attribution. */
export type PhantomTriggerSource = "schedule" | "block";

/** Failure codes the scheduler assigns when an enqueue fails. */
export type SchedulerErrorCode = "CS-0001" | "BS-0001" | "N-0002";

/** Why the platform refused to create the phantom. */
export type PhantomRefusalReason = "plan_feature" | "execution_limit";

/**
 * Why a skip-if-running dispatch was not checked: the workflow is gone or may
 * not run (answers, not faults), or the check itself failed.
 */
export type SkipCheckOutcome = "workflow_gone" | "workflow_inactive" | "failed";

/** Result of a phantom pre-create attempt. */
export interface PhantomCreateResult {
  /** Id of the phantom row, or undefined when the call failed. */
  executionId?: string;
  /**
   * True when a row already existed for this dispatch key, i.e. another
   * dispatcher (an overlapping leader on failover/rollout, or a catch-up window
   * re-running the occurrence) already created and enqueued it. The caller must
   * then skip its own enqueue to avoid a duplicate SQS message.
   */
  alreadyExisted: boolean;
  /**
   * Set when the platform refused this dispatch on plan grounds (over the
   * execution limit, or a gated action). The caller must skip its enqueue: the
   * executor would refuse the same run, so the SQS message and the round-trip
   * are pure waste. Distinct from an undefined `executionId` with no refusal,
   * which is a transport failure and still falls back to the id-less enqueue.
   */
  refused?: PhantomRefusalReason;
  /**
   * Do not enqueue: the dispatch is recorded as skipped (a live run, or a refused
   * phantom), or, with no executionId, the skip-if-running check did not run.
   */
  skipped?: boolean;
  /** Set with `skipped` and no executionId: why the check did not run. */
  skipCheck?: SkipCheckOutcome;
}

/** The platform's coded answer that this workflow cannot run, if the error is one. */
function workflowCannotRun(
  error: unknown,
): "workflow_gone" | "workflow_inactive" | undefined {
  if (!(error instanceof ApiError)) {
    return;
  }
  let code: unknown;
  try {
    code = (JSON.parse(error.body) as { code?: unknown }).code;
  } catch {
    return;
  }
  if (error.status === 404 && code === "WORKFLOW_NOT_FOUND") {
    return "workflow_gone";
  }
  if (error.status === 403 && code === "WORKFLOW_INACTIVE") {
    return "workflow_inactive";
  }
  return;
}

// A workflow that cannot run is logged once per workflow per interval, not per block.
const CANNOT_RUN_LOG_INTERVAL_MS = 10 * 60 * 1000;
const cannotRunLoggedAt = new Map<string, number>();

// Skip-if-running fails closed: without the platform's check, a run could overlap the live one.
function skipCheckFailed(
  workflowId: string,
  dispatchKey: string | undefined,
  cause: unknown,
): PhantomCreateResult {
  const cannotRun = workflowCannotRun(cause);
  if (cannotRun) {
    const now = Date.now();
    const last = cannotRunLoggedAt.get(workflowId);
    if (last === undefined || now - last >= CANNOT_RUN_LOG_INTERVAL_MS) {
      if (cannotRunLoggedAt.size >= 10_000) {
        cannotRunLoggedAt.clear();
      }
      cannotRunLoggedAt.set(workflowId, now);
      console.log(
        `[Phantom] Not dispatching workflow ${workflowId}: the platform says it cannot run (${cannotRun})`,
      );
    }
    return { alreadyExisted: false, skipped: true, skipCheck: cannotRun };
  }
  console.error(
    `[Phantom] Skip-if-running check failed for workflow ${workflowId}, not dispatching ${dispatchKey ?? "(no key)"}:`,
    cause,
  );
  return { alreadyExisted: false, skipped: true, skipCheck: "failed" };
}

/**
 * Pre-create a phantom execution row. Returns its id and whether a row already
 * existed for the given dispatch key. On failure returns
 * `{ alreadyExisted: false }` with no id, so the caller falls back to the
 * legacy id-less enqueue (the executor inserts its own row); with
 * `skipIfRunning` it returns `skipped: true` instead, so nothing is enqueued.
 *
 * `dispatchKey` is a stable per-occurrence idempotency key. When
 * two dispatchers compute the same key the unique index on the row makes the
 * second insert a no-op and this returns `alreadyExisted: true`.
 */
export async function createPhantomExecution(
  workflowId: string,
  triggerSource: PhantomTriggerSource,
  userId?: string,
  dispatchKey?: string,
  options: { skipIfRunning?: boolean } = {},
): Promise<PhantomCreateResult> {
  try {
    const { data: result, attempts } = await apiRequestWithAttempts<{
      executionId?: string;
      alreadyExisted?: boolean;
      skipped?: boolean;
      refused?: boolean;
      reason?: PhantomRefusalReason;
      error?: string;
    }>("/api/internal/executions", {
      method: "POST",
      body: JSON.stringify({
        workflowId,
        userId,
        status: "phantom",
        triggerSource,
        dispatchKey,
        ...(options.skipIfRunning ? { skipIfRunning: true } : {}),
      }),
    });
    if (result.refused) {
      const reason: PhantomRefusalReason = result.reason ?? "execution_limit";
      console.log(
        `[Phantom] Dispatch refused for workflow ${workflowId} (${reason}): ${result.error ?? ""}`,
      );
      return { alreadyExisted: false, refused: reason };
    }
    // A dedup hit is only trustworthy on the first attempt. After a retry the
    // existing row may be this dispatcher's own, created by an attempt whose
    // reply was lost, so nobody has enqueued it yet: report it as fresh and let
    // the caller enqueue. If another dispatcher did enqueue it, the second
    // message is harmless (the executor's status CAS drops the duplicate
    // delivery); skipping instead would strand the phantom until the reaper
    // marks it P-0005 and the occurrence would never run.
    const alreadyExisted = attempts === 1 && result.alreadyExisted === true;
    if (result.skipped === true) {
      return { executionId: result.executionId, alreadyExisted, skipped: true };
    }
    if (options.skipIfRunning && !result.executionId) {
      return skipCheckFailed(workflowId, dispatchKey, "no execution id");
    }
    return { executionId: result.executionId, alreadyExisted };
  } catch (error) {
    if (options.skipIfRunning) {
      return skipCheckFailed(workflowId, dispatchKey, error);
    }
    console.warn(
      `[Phantom] Failed to pre-create execution for workflow ${workflowId}:`,
      error,
    );
    return { alreadyExisted: false };
  }
}

/**
 * Resolve a phantom row to a coded failure after an enqueue error. Swallows
 * its own errors -- the reaper is the backstop for an unmarked phantom.
 */
export async function failPhantomExecution(
  executionId: string,
  errorCode: SchedulerErrorCode,
  errorMessage: string,
): Promise<void> {
  try {
    await apiRequest(`/api/internal/executions/${executionId}`, {
      method: "PATCH",
      body: JSON.stringify({
        // KEEP-853: an enqueue failure is a platform/infra fault, so the run
        // surfaces as a system error, distinct from user/workflow errors.
        status: "system_error",
        error: errorMessage,
        errorCode,
      }),
    });
  } catch (error) {
    console.warn(
      `[Phantom] Failed to mark execution ${executionId} as failed:`,
      error,
    );
  }
}
