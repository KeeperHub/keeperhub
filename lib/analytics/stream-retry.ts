/**
 * Whether a closed analytics stream should be reopened, and after how long.
 *
 * The server recycles every stream on MAX_LIFETIME_MS, so the browser sees an
 * error on a healthy connection every few minutes. Treating that close as fatal
 * moves the viewer onto the poll, which costs five requests per tick and never
 * returns to the stream. Reconnecting first keeps a healthy viewer off the poll
 * entirely, and polling stays available for a stream that really is gone.
 */
export type StreamRetryDecision =
  | { action: "reconnect"; delayMs: number }
  | { action: "poll" };

export const SSE_RECONNECT_BASE_MS = 1000;
export const SSE_RECONNECT_MAX_ATTEMPTS = 3;

export function nextStreamRetry(
  attempts: number,
  baseMs: number = SSE_RECONNECT_BASE_MS,
  maxAttempts: number = SSE_RECONNECT_MAX_ATTEMPTS
): StreamRetryDecision {
  if (attempts >= maxAttempts) {
    return { action: "poll" };
  }
  // Exponential so a genuine outage backs off, bounded by maxAttempts.
  return { action: "reconnect", delayMs: baseMs * 2 ** attempts };
}
