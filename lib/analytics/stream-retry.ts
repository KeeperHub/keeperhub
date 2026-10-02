/**
 * Whether a closed analytics stream should be reopened, and after how long.
 *
 * The server recycles every stream on MAX_LIFETIME_MS, so the browser sees an
 * error on a healthy connection every few minutes. Reopening keeps the summary
 * events flowing across that recycle instead of ending them at the first close.
 *
 * Giving up costs the summary only. The refresh that keeps the runs table, the
 * chart, the network panel and the status counts current does not run on this
 * stream, so it is unaffected by whatever this decides.
 */
export type StreamRetryDecision =
  | { action: "reconnect"; delayMs: number }
  | { action: "stop" };

export const SSE_RECONNECT_BASE_MS = 1000;
export const SSE_RECONNECT_MAX_ATTEMPTS = 3;

export function nextStreamRetry(
  attempts: number,
  baseMs: number = SSE_RECONNECT_BASE_MS,
  maxAttempts: number = SSE_RECONNECT_MAX_ATTEMPTS
): StreamRetryDecision {
  if (attempts >= maxAttempts) {
    return { action: "stop" };
  }
  // Exponential so a genuine outage backs off, bounded by maxAttempts.
  return { action: "reconnect", delayMs: baseMs * 2 ** attempts };
}
