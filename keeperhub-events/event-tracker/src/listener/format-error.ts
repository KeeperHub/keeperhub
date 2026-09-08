/**
 * Convert an unknown caught value into a log-friendly string, preserving
 * the stack trace when present. `String(err)` on an Error returns only
 * `"Error: message"` and drops the stack, which is the piece an operator
 * actually needs for triage.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}
