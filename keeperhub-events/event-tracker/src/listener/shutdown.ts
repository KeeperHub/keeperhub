/**
 * Shutdown-time primitives shared by the dispatch path.
 *
 * A matched event parks before it is forwarded to SQS - on the pacer under
 * contention, on the legacy jitter otherwise. That park is the window in
 * which SIGTERM loses the event outright, so shutdown does two things to it:
 * it stops the park (this module's signal) and then waits for the handlers
 * to finish dispatching (`InFlightTracker`).
 */

/**
 * How long `stopAll` waits for in-flight handlers before giving up and
 * letting the process exit.
 *
 * Sized against the 30s K8s default grace period, not copied from the
 * executor's 25s: this process still has to tear down the provider manager
 * (a WSS close per chain) and the health server after the drain returns, and
 * a drain that outlives the grace period is SIGKILLed with nothing logged -
 * the exact failure this drain exists to remove.
 *
 * 20s is chosen to cover one dispatch stuck on the internal API. A
 * `createPhantomExecution` that gets no answer spends 3 attempts at
 * `REQUEST_TIMEOUT_MS = 5_000` plus `RETRY_DELAYS_MS = [500, 1_000]` before
 * giving up - 16.5s (`lib/phantom.ts`). Nothing under the grace period can
 * also cover the send-failure path, where `failPhantomExecution` runs the
 * same ladder again; that case times out and is logged, which is the
 * designed outcome rather than a gap.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

/**
 * Sleeps for `ms`, or returns early when `signal` aborts.
 *
 * Resolves in both cases - it never rejects. An abort here means "stop
 * waiting and dispatch now", not "cancel this event". That is the right
 * trade at shutdown: pacing exists to keep a spike off SQS and the phantom
 * execution API, and a burst into SQS is recoverable where a dropped trigger
 * is not. Because it resolves rather than throws, callers need no
 * abort-specific branch and a parked event follows its normal path straight
 * through to the send.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // `onAbort` closes over `timer` before it is declared. Safe: the listener
    // is registered after the timer is assigned, so the handle always exists
    // by the time abort can fire.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
