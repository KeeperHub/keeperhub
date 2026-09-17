/**
 * A caller-supplied hook that runs at the moment a write path is about to
 * broadcast, and at the points after that where the sponsored path learns
 * something about the send.
 *
 * Why it exists: the step result cannot say whether a failed send reached the
 * chain. A signed EVM transaction whose broadcast throws is rethrown without
 * its already-known hash when reconciliation misses it (submit-signed.ts); a
 * sponsored send can end pending with only Turnkey's activity id; a Solana
 * send drops its signature on every post-submit failure. A caller that must
 * never send the same payment twice therefore cannot classify "no hash" as
 * "not broadcast". The hook marks the boundary from the code that actually
 * broadcasts, so "the hook never fired" is the only proof of pre-broadcast.
 *
 * Semantics every call site follows:
 *
 * - Awaited, in sequence, before the broadcast it describes. There is no
 *   timeout and nothing races it: a slow hook delays the send, it never lets
 *   the send proceed without it.
 * - A hook that throws aborts the send. The error surfaces as
 *   BroadcastHookError and is never swallowed or treated as a pre-broadcast
 *   failure that permits a fallback.
 * - Absent hook: every call site is a no-op, and the send path is unchanged.
 */

export type BroadcastEvent =
  /** EVM: signed, not yet broadcast. The hash is final. */
  | { kind: "evm-signed"; transactionHash: string }
  /** Solana: signed, not yet submitted. The signature is final. */
  | { kind: "solana-signed"; signature: string }
  /** Sponsored: about to ask Turnkey to sign and broadcast. */
  | { kind: "sponsored-submitting" }
  /**
   * Sponsored: Turnkey accepted the activity. Already submitted, so a hook
   * that throws here cannot abort anything; the send is reported pending with
   * the id instead of being allowed to fall back.
   */
  | { kind: "sponsored-accepted"; sendTransactionStatusId: string }
  /**
   * Sponsored: Turnkey reported a definite end before broadcast (an outright
   * rejection or a terminal pre-broadcast status). The same judgement the
   * direct-signing fallback already relies on.
   */
  | { kind: "sponsored-not-broadcast" };

export type BroadcastHook = (event: BroadcastEvent) => Promise<void>;

export class BroadcastHookError extends Error {
  readonly kind = "broadcast-hook" as const;
  readonly eventKind: BroadcastEvent["kind"];

  constructor(eventKind: BroadcastEvent["kind"], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Pre-broadcast hook failed at ${eventKind}; the send was not attempted: ${reason}`,
      { cause }
    );
    this.name = "BroadcastHookError";
    this.eventKind = eventKind;
  }
}

/** Duck-typed like the other write-path guards: module registries can differ. */
export function isBroadcastHookError(
  error: unknown
): error is BroadcastHookError {
  return (
    error instanceof Error &&
    (error as BroadcastHookError).kind === "broadcast-hook"
  );
}

/** Runs the hook if there is one; any throw becomes a BroadcastHookError. */
export async function runBroadcastHook(
  hook: BroadcastHook | undefined,
  event: BroadcastEvent
): Promise<void> {
  if (!hook) {
    return;
  }
  try {
    await hook(event);
  } catch (error) {
    throw new BroadcastHookError(event.kind, error);
  }
}
