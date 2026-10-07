/**
 * How far to follow an error's `cause` chain before giving up.
 *
 * Five modules walk that chain to find a driver-level code that a wrapper has
 * buried (lib/db/errors.ts, lib/security/backstop-capture.ts,
 * lib/security/session-backstop.ts, lib/workflow/nodes/database-query/step.ts,
 * lib/workflow/retry-policy.ts), and each had picked the same bound
 * independently. One of them even documents that it mirrors another.
 *
 * Note: database-query/step.ts compares with `<=` where the other four use
 * `<`, so it inspects one more level than they do. That difference predates
 * this constant being shared and is left as-is rather than quietly changed on
 * a retry path.
 */

export const MAX_CAUSE_DEPTH = 5;

/**
 * First value in `error`, its `cause` chain, or the `errors` of an
 * AggregateError (Node reports one per address it tried) that `match` accepts.
 */
export function findInErrorChain(
  error: unknown,
  match: (candidate: object) => boolean,
  depth = 0
): object | undefined {
  if (depth >= MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) {
    return;
  }
  if (match(error)) {
    return error;
  }
  const { cause, errors } = error as { cause?: unknown; errors?: unknown };
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const found = findInErrorChain(inner, match, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return findInErrorChain(cause, match, depth + 1);
}
