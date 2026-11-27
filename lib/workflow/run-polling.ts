// How often open run views read a run again.

export const RUNNING_POLL_MS = 500;
// A not landed run can still re-settle within about a day, so an open view reads it again slowly.
const SLOW_POLL_MS = 60_000;

/** How soon the canvas reads a selected run's step states again; null stops. */
export function selectedRunPollMs(status: string): number | null {
  if (status === "running" || status === "pending") {
    return RUNNING_POLL_MS;
  }
  return status === "not_landed" ? SLOW_POLL_MS : null;
}

/**
 * After a failed read: stop on a 4xx (deleted run, no access), else retry
 * slowly (network error, 5xx, 408, 429). `httpStatus` is undefined without a response.
 */
export function selectedRunPollMsAfterError(
  httpStatus: number | undefined
): number | null {
  const refused =
    httpStatus !== undefined &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    httpStatus !== 408 &&
    httpStatus !== 429;
  return refused ? null : SLOW_POLL_MS;
}

/**
 * Whether the Runs panel loads an open run's steps again: while it runs, and
 * once for each end status it reaches (a not landed run can re-settle later).
 */
export function runLogsDue(
  status: string,
  ended: boolean,
  loadedAtEnd: string | undefined
): boolean {
  return !ended || loadedAtEnd !== status;
}
