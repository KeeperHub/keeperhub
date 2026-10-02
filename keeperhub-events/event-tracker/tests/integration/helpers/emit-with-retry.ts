/**
 * How many times a single emit may hit an ephemeral nonce rejection before
 * we give up. The outer SQS-poll loops in these tests already allow up to
 * ten emits, so a small per-emit retry budget keeps the worst case bounded.
 */
const MAX_NONCE_RETRIES = 3;

function isEphemeralNonceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // ethers wraps anvil's -32003 as NONCE_EXPIRED with either the node's
  // "nonce too low" or the provider's "nonce has already been used" text.
  // Both mean the same thing here: the signed nonce lost a race, not that
  // the contract call is wrong.
  return (
    message.includes("NONCE_EXPIRED") ||
    message.includes("nonce too low") ||
    message.includes("nonce has already been used")
  );
}

/**
 * Call a contract write and retry only on ephemeral nonce rejections.
 *
 * The integration suites share one anvil account (the well-known first
 * deterministic key) across all test files. Anvil auto-mines every
 * transaction, but ethers' JsonRpcProvider can briefly serve a stale
 * cached pending-nonce, so a correctly-formed transaction is rejected
 * with "nonce too low" / "nonce has already been used". That rejection is
 * an artifact of the shared wallet, not a property of the code under
 * test, so it must not fail an emit loop that exists to tolerate missed
 * events. Any other error propagates immediately.
 *
 * Known tradeoff, accepted deliberately: "nonce too low" can also mean
 * the transaction already landed, in which case a retry emits the event a
 * second time. The retry sends a fresh transaction, so it lands with a new
 * tx hash and log index - the tracker's tx-hash/log-id dedupe does NOT
 * collapse it into the original; the duplicate is tolerated only because
 * the emit loops around every call site accept any message and count a
 * duplicate fixture event the same as the original. In other words the
 * retry is duplicate-side-effect by design, not idempotent, and the
 * dedupe does not cover it. Revisit before reusing this helper anywhere a
 * repeated write is not tolerated.
 */
export async function emitWithNonceRetry<T>(
  emit: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_NONCE_RETRIES; attempt++) {
    try {
      return await emit();
    } catch (err) {
      if (!isEphemeralNonceError(err)) {
        throw err;
      }
      lastErr = err;
      // Anvil auto-mines, so by the next tick the account nonce has
      // advanced past the lost race; a short backoff is enough. No sleep
      // after the final attempt: the caller is about to see the throw,
      // and the backoff exists only to give the next attempt a chance.
      if (attempt < MAX_NONCE_RETRIES) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}
