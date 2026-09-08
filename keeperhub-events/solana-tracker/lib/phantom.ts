/**
 * Phantom execution helpers (KEEP-693). Before enqueuing a trigger the ingestor
 * pre-creates a 'phantom' workflow_executions row via the internal API so the
 * run is visible even if it never reaches the executor; the executor upgrades it
 * to 'pending' on dequeue. If the enqueue fails, the phantom is resolved to a
 * coded failure. Both calls are best-effort and must never fail a real trigger.
 *
 * The create carries a per-fire dispatch key. The row's unique index on that
 * key turns a second create for the same fire (a re-processed block, a crash
 * between the SQS send and the Redis mark) into a no-op that reports
 * `alreadyExisted`, so the caller skips its enqueue instead of starting a
 * second run. The Redis dedup in front of this is best-effort; the key holds.
 *
 * Serves both trigger kinds: event triggers sign as caller "events" with
 * triggerSource "event"; block triggers sign as "scheduler" with source "block".
 */

import { KEEPERHUB_API_URL } from "./config/environment";
import { type HmacCaller, signHmacHeaders } from "./utils/fetch-utils";
import { logger } from "./utils/logger";

export type PhantomTriggerSource = "event" | "block";
/** ES-* = event enqueue failure, BS-* = block enqueue failure, N-* = generic. */
export type PhantomErrorCode = "ES-0001" | "BS-0001" | "N-0002";

/** Why the platform refused to create the phantom. */
export type PhantomRefusalReason = "plan_feature" | "execution_limit";

/** Result of a phantom pre-create attempt. */
export type PhantomCreateResult = {
  /** Id of the phantom row, or undefined when the call failed. */
  executionId?: string;
  /**
   * True when a row already existed for this dispatch key, i.e. an earlier
   * pass over the same block already created and enqueued it. The caller must
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
 * keeperhub-events/event-tracker/lib/phantom.ts (this package cannot import
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
 * Pre-create a phantom execution row for one fire, keyed by `dispatchKey`.
 * Returns its id and whether a row already existed for that key, a refusal
 * when the platform declined the dispatch on plan grounds, or neither when the
 * call fails (the caller then enqueues without an id and the executor inserts
 * its own row).
 */
export async function createPhantomExecution(
  workflowId: string,
  userId: string,
  source: PhantomTriggerSource,
  caller: HmacCaller,
  dispatchKey: string,
): Promise<PhantomCreateResult> {
  const url = `${KEEPERHUB_API_URL}/api/internal/executions`;
  const body = JSON.stringify({
    workflowId,
    userId,
    status: "phantom",
    triggerSource: source,
    dispatchKey,
  });
  try {
    const { response, attempts } = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signHmacHeaders("POST", url, body, caller),
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
    // existing row may be this ingestor's own, created by an attempt whose
    // reply was lost, so nobody has enqueued it yet: report it as fresh and let
    // the caller enqueue. If an earlier pass did enqueue it, the second message
    // is harmless (the executor's status CAS drops the duplicate delivery);
    // skipping instead would strand the phantom until the reaper marks it
    // P-0005 and the fire would never run.
    const alreadyExisted = attempts === 1 && data.alreadyExisted === true;
    return { executionId: data.executionId, alreadyExisted };
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to pre-create execution for ${workflowId}: ${formatError(error)}`,
    );
    return { alreadyExisted: false };
  }
}

export async function failPhantomExecution(
  executionId: string,
  errorCode: PhantomErrorCode,
  errorMessage: string,
  caller: HmacCaller,
): Promise<void> {
  const url = `${KEEPERHUB_API_URL}/api/internal/executions/${executionId}`;
  const body = JSON.stringify({
    status: "system_error",
    error: errorMessage,
    errorCode,
  });
  try {
    const { response } = await fetchWithRetry(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...signHmacHeaders("PATCH", url, body, caller),
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
