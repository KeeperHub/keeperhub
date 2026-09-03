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
 * must ever block or fail a real trigger.
 */

import { apiRequest, apiRequestWithAttempts } from "./http-client.js";

/** Trigger sources the scheduler reports for phantom attribution. */
export type PhantomTriggerSource = "schedule" | "block";

/** Failure codes the scheduler assigns when an enqueue fails. */
export type SchedulerErrorCode = "CS-0001" | "BS-0001" | "N-0002";

/** Why the platform refused to create the phantom. */
export type PhantomRefusalReason = "plan_feature" | "execution_limit";

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
}

/**
 * Pre-create a phantom execution row. Returns its id and whether a row already
 * existed for the given dispatch key. On failure returns
 * `{ alreadyExisted: false }` with no id, so the caller falls back to the
 * legacy id-less enqueue (the executor inserts its own row).
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
): Promise<PhantomCreateResult> {
  try {
    const { data: result, attempts } = await apiRequestWithAttempts<{
      executionId?: string;
      alreadyExisted?: boolean;
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
    return { executionId: result.executionId, alreadyExisted };
  } catch (error) {
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
