/**
 * How a reserved idempotency record should be settled once the work returns.
 *
 * Deliberately its own module with no imports. `lib/idempotency.ts` reaches the
 * database, so anything importing it in a test drags a database in and the
 * usual answer is to mock the whole module -- which means the route tests end
 * up asserting against a hand-copied version of this rule and can never catch a
 * regression in the real one. Keeping the rule importable on its own lets those
 * tests exercise the same code the routes run.
 *
 *   "success"  -> store a replayable completed record (2xx happy path).
 *   "failed"   -> the outcome is NOT known: a broadcast may still land
 *                 (unreadable receipt, a throw with no hash to check). Keep the
 *                 row so a retry replays instead of broadcasting a second
 *                 transaction for work the first attempt may still finish.
 *   "release"  -> the outcome is definite: either nothing was broadcast
 *                 (reservation denied, requireWallet, validation 4xx, a
 *                 staticCall rejection before a nonce was allocated) or the
 *                 chain conclusively rejected it. Drop the row so the same key
 *                 can be used again.
 *
 * The dividing line is certainty, not success. A definite failure that changed
 * no state has no reason to hold a key for 24 hours, while an unknown outcome
 * must hold one even though it looks like a failure to the caller.
 */
export type IdempotencyDisposition = "success" | "failed" | "release";

/**
 * Map an execution outcome onto a disposition.
 *
 * `completeExecution` and `failExecution` already adjudicate the only question
 * that matters here -- the chain decides, and a receipt that cannot be read
 * yields `unconfirmed` rather than `failed`. Routes previously discarded that
 * verdict by writing `status === "completed" ? "success" : "failed"`, which
 * collapsed a definite failure and an unknown one onto the same held key. A
 * caller whose transaction was rejected before a nonce was even allocated then
 * replayed that rejection for the full 24-hour window and could never recover
 * on the same key, while rotating the key to escape it reopened the
 * double-broadcast hole the key exists to close.
 *
 * Centralised because five `/api/execute/*` routes need the identical rule, and
 * one of them drifting is indistinguishable from that bug coming back.
 */
export function dispositionForExecutionOutcome(
  status: "completed" | "failed" | "unconfirmed"
): IdempotencyDisposition {
  if (status === "completed") {
    return "success";
  }
  // Definite, and nothing left in flight: the key is free to use again.
  if (status === "failed") {
    return "release";
  }
  // `unconfirmed`: the chain has not answered. Hold the key.
  return "failed";
}
