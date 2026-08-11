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

import { apiRequest } from "./http-client.js";

/** Trigger sources the scheduler reports for phantom attribution. */
export type PhantomTriggerSource = "schedule" | "block";

/** Failure codes the scheduler assigns when an enqueue fails. */
export type SchedulerErrorCode = "CS-0001" | "BS-0001" | "N-0002";

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
    const result = await apiRequest<{
      executionId: string;
      alreadyExisted?: boolean;
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
    return {
      executionId: result.executionId,
      alreadyExisted: result.alreadyExisted ?? false,
    };
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
