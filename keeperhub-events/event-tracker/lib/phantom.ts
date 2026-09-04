/**
 * Phantom execution helpers (KEEP-693).
 *
 * Before enqueuing an event trigger, the listener pre-creates a 'phantom'
 * workflow_executions row via the internal API so the run is visible even if it
 * never reaches the executor. The executor upgrades that row to 'pending' on
 * dequeue. If the enqueue itself fails, the listener resolves the phantom to a
 * coded failure so it surfaces in the run logs.
 *
 * The create carries a per-log dispatch key. The row's unique index on that key
 * turns a second create for the same log (a WSS reconnect replaying it, a reorg
 * re-emitting it, a crash between the SQS send and the Redis mark) into a no-op
 * that reports `alreadyExisted`, so the caller skips its enqueue instead of
 * starting a second run. The Redis dedup in front of this is best-effort; the
 * key is what actually holds.
 *
 * Both calls are best-effort and must never block or fail a real trigger: a
 * failed create degrades to the legacy id-less enqueue (the executor inserts
 * its own row), and a failed mark is swallowed (the reaper ages it out).
 *
 * Auth mirrors fetchActiveWorkflows: HMAC-signed internal-service headers
 * (caller "events") over the request body.
 */

import { KEEPERHUB_API_URL } from "./config/environment";
import { signHmacHeaders } from "./utils/fetch-utils";
import { logger } from "./utils/logger";

/** Failure codes the event tracker assigns when an enqueue fails. */
export type EventErrorCode = "ES-0001" | "N-0002";

/** Why the platform refused to create the phantom. */
export type PhantomRefusalReason = "plan_feature" | "execution_limit";

/** Result of a phantom pre-create attempt. */
export type PhantomCreateResult = {
  /** Id of the phantom row, or undefined when the call failed. */
  executionId?: string;
  /**
   * True when a row already existed for this dispatch key, i.e. an earlier
   * delivery of the same log already created and enqueued it. The caller must
   * then skip its own enqueue to avoid a duplicate SQS message and run.
   */
  alreadyExisted: boolean;
  /**
   * Set when the platform refused this dispatch on plan grounds. The caller
   * must skip its enqueue: the executor would refuse the same run. Distinct
   * from an undefined `executionId` with no refusal, which is a transport
   * failure and still falls back to the id-less enqueue.
   */
  refused?: PhantomRefusalReason;
};

/**
 * Per-attempt budget and retry schedule for the internal API calls below. A
 * transport failure (connection refused or reset, DNS, the timeout) or a 5xx
 * reply is retried on the schedule; a 4xx is a definitive answer and is not.
 * Retrying the create is only safe because the dispatch key makes it
 * idempotent; the PATCH is idempotent through its status compare-and-set.
 *
 * Keep in sync with keeperhub-scheduler/lib/http-client.ts and
 * keeperhub-events/solana-tracker/lib/phantom.ts (this package cannot import
 * either).
 */
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS: readonly number[] = [500, 1_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

type FetchResult = {
  response: Response;
  /** 1 when the first attempt was answered; higher when a retry was. */
  attempts: number;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with a per-attempt timeout, retrying transport failures and 5xx replies
 * on the schedule above. Resolves with the first non-5xx response (or the last
 * 5xx once the schedule is exhausted) and the attempt that produced it; rejects
 * with the last transport error when every attempt failed to get a response.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<FetchResult> {
  for (let attempt = 1; ; attempt++) {
    const isLast = attempt === MAX_ATTEMPTS;
    let failure: string;
    try {
      const response = await fetchWithTimeout(url, init);
      const serverError = !response.ok && response.status >= 500;
      if (!serverError || isLast) {
        return { response, attempts: attempt };
      }
      failure = `HTTP ${response.status}`;
    } catch (error) {
      if (isLast) {
        throw error;
      }
      failure = formatError(error);
    }
    const delayMs = RETRY_DELAYS_MS[attempt - 1];
    logger.warn(
      `[Phantom] ${init.method ?? "GET"} ${url} attempt ${attempt}/${MAX_ATTEMPTS} failed (${failure}); retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }
}

/**
 * Pre-create a phantom execution row for one log, keyed by `dispatchKey`.
 * Returns its id and whether a row already existed for that key, a refusal
 * when the platform declined the dispatch on plan grounds, or neither when the
 * call fails (the caller then enqueues without an id and the executor inserts
 * its own row).
 */
export async function createPhantomExecution(
  workflowId: string,
  userId: string,
  dispatchKey: string,
): Promise<PhantomCreateResult> {
  const url = `${KEEPERHUB_API_URL}/api/internal/executions`;
  const body = JSON.stringify({
    workflowId,
    userId,
    status: "phantom",
    triggerSource: "event",
    dispatchKey,
  });
  try {
    const { response, attempts } = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signHmacHeaders("POST", url, body),
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      executionId?: string;
      alreadyExisted?: boolean;
      refused?: boolean;
      reason?: PhantomRefusalReason;
      error?: string;
    };
    if (data.refused) {
      const reason: PhantomRefusalReason = data.reason ?? "execution_limit";
      logger.log(
        `[Phantom] Dispatch refused for ${workflowId} (${reason}): ${data.error ?? ""}`,
      );
      return { alreadyExisted: false, refused: reason };
    }
    // A dedup hit is only trustworthy on the first attempt. After a retry the
    // existing row may be this listener's own, created by an attempt whose
    // reply was lost, so nobody has enqueued it yet: report it as fresh and let
    // the caller enqueue. If an earlier delivery did enqueue it, the second
    // message is harmless (the executor's status CAS drops the duplicate
    // delivery); skipping instead would strand the phantom until the reaper
    // marks it P-0005 and the event would never run.
    const alreadyExisted = attempts === 1 && data.alreadyExisted === true;
    return { executionId: data.executionId, alreadyExisted };
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to pre-create execution for ${workflowId}: ${formatError(error)}`,
    );
    return { alreadyExisted: false };
  }
}

/**
 * Resolve a phantom row to a coded failure after an enqueue error. Swallows its
 * own errors -- the reaper is the backstop for an unmarked phantom.
 */
export async function failPhantomExecution(
  executionId: string,
  errorCode: EventErrorCode,
  errorMessage: string,
): Promise<void> {
  const url = `${KEEPERHUB_API_URL}/api/internal/executions/${executionId}`;
  const body = JSON.stringify({
    // KEEP-853: an enqueue failure is a platform/infra fault, so the run
    // surfaces as a system error, distinct from user/workflow errors.
    status: "system_error",
    error: errorMessage,
    errorCode,
  });
  try {
    const { response } = await fetchWithRetry(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...signHmacHeaders("PATCH", url, body),
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to mark execution ${executionId} as failed: ${formatError(error)}`,
    );
  }
}
