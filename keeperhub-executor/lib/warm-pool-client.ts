import {
  WARM_POOL_ACK_PATH,
  WARM_POOL_CLAIM_PATH,
  WARM_POOL_DECISION_HEADER,
  WARM_POOL_EXECUTION_HEADER,
  WARM_POOL_TOKEN_HEADER,
  type WarmAckDecision,
  type WarmAssignment,
  warmAssignmentSchema,
} from "../warm-pool-protocol";

/**
 * Warm-pod side of the warm pool (see ../warm-pool.ts): long-poll the owning
 * executor until it hands over exactly one execution, or until this pod should
 * exit without running anything.
 */

export type ClaimOutcome =
  | { kind: "assigned"; assignment: WarmAssignment }
  | { kind: "exit"; reason: string };

export type WaitForAssignmentOptions = {
  claimUrl: string;
  token: string;
  /** Give up and exit after waiting this long with no assignment. */
  maxIdleMs: number;
  /** Give up after the executor has been unreachable for this long. */
  unreachableGraceMs?: number;
  /** Client-side cap on one long-poll; above the executor's hold time. */
  requestTimeoutMs?: number;
  /** Runs after each empty poll, e.g. to keep a DB connection warm. */
  onIdle?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_UNREACHABLE_GRACE_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5000;
// A held claim request takes up to the executor's long-poll window; an empty
// answer much faster than this means the executor could not hold it (pod not
// verified yet), so wait before asking again rather than loop on it.
const MIN_POLL_INTERVAL_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type PollResult =
  | { kind: "assigned"; assignment: WarmAssignment }
  | { kind: "empty" }
  | { kind: "released" }
  | { kind: "invalid"; reason: string }
  | { kind: "unreachable"; reason: string };

async function pollOnce(
  url: string,
  token: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<PollResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { [WARM_POOL_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      kind: "unreachable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 204) {
    return { kind: "empty" };
  }
  if (response.status === 410) {
    return { kind: "released" };
  }
  if (response.status !== 200) {
    return { kind: "unreachable", reason: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "invalid", reason: "assignment is not JSON" };
  }
  const parsed = warmAssignmentSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: "invalid", reason: parsed.error.message };
  }
  return { kind: "assigned", assignment: parsed.data };
}

export async function waitForAssignment(
  options: WaitForAssignmentOptions
): Promise<ClaimOutcome> {
  const {
    claimUrl,
    token,
    maxIdleMs,
    unreachableGraceMs = DEFAULT_UNREACHABLE_GRACE_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onIdle,
    fetchImpl = fetch,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const url = new URL(WARM_POOL_CLAIM_PATH, claimUrl).toString();
  const startedAt = now();
  let unreachableSince: number | undefined;
  let retryDelayMs = 500;

  while (now() - startedAt < maxIdleMs) {
    const pollStartedAt = now();
    const result = await pollOnce(url, token, requestTimeoutMs, fetchImpl);

    switch (result.kind) {
      case "assigned":
        return result;
      case "released":
        return { kind: "exit", reason: "released by executor" };
      case "invalid":
        return { kind: "exit", reason: `invalid assignment: ${result.reason}` };
      case "empty": {
        unreachableSince = undefined;
        retryDelayMs = 500;
        if (onIdle) {
          try {
            await onIdle();
          } catch {
            // Keep-alive work is best effort; the next poll is what matters.
          }
        }
        const elapsedMs = now() - pollStartedAt;
        if (elapsedMs < MIN_POLL_INTERVAL_MS) {
          await sleep(MIN_POLL_INTERVAL_MS - elapsedMs);
        }
        break;
      }
      case "unreachable": {
        unreachableSince ??= now();
        if (now() - unreachableSince >= unreachableGraceMs) {
          return {
            kind: "exit",
            reason: `executor unreachable: ${result.reason}`,
          };
        }
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
        break;
      }
      default: {
        const exhaustive: never = result;
        return { kind: "exit", reason: `unexpected poll result ${exhaustive}` };
      }
    }
  }

  return { kind: "exit", reason: "idle lifetime reached" };
}

const ACK_REQUEST_TIMEOUT_MS = 2000;

/**
 * Tell the executor whether this pod takes the offered execution. Returns
 * true only when the pod accepted and the executor confirmed (200); in every
 * other case (refusal, 410 because the executor already started a per-run
 * Job, unreachable executor) the pod must not run the execution.
 */
export async function acknowledgeAssignment(options: {
  claimUrl: string;
  token: string;
  executionId: string;
  decision: WarmAckDecision;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { claimUrl, token, executionId, decision, fetchImpl = fetch } = options;
  try {
    const response = await fetchImpl(
      new URL(WARM_POOL_ACK_PATH, claimUrl).toString(),
      {
        method: "POST",
        headers: {
          [WARM_POOL_TOKEN_HEADER]: token,
          [WARM_POOL_EXECUTION_HEADER]: executionId,
          [WARM_POOL_DECISION_HEADER]: decision,
        },
        signal: AbortSignal.timeout(ACK_REQUEST_TIMEOUT_MS),
      }
    );
    return decision === "accept" && response.status === 200;
  } catch {
    return false;
  }
}
