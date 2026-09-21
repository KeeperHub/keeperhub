/**
 * Returns true when the error is a PostgreSQL statement timeout (SQLSTATE 57014).
 * Drizzle wraps the driver error in DrizzleQueryError with the original on
 * error.cause, so we check both levels.
 *
 * Shared because two callers act on the code rather than log it: the executor
 * falls back to the tracker when its step-output read is cancelled, and the
 * retention plan-window drain reads a cancelled runs read as "this time slice
 * is too wide" and narrows it.
 */
export function isStatementTimeout(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown })?.cause];
  return candidates.some(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      (e as { code?: unknown }).code === "57014"
  );
}
