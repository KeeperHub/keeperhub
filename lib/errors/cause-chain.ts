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
