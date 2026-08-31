import "server-only";

/**
 * Thrown when a directly-signed transaction was broadcast and then reverted
 * on-chain (receipt status 0).
 *
 * Mirrors SponsoredTxRevertError on the sponsored path: both mean "a real
 * transaction exists and it failed", as opposed to a pre-broadcast failure
 * where no hash exists at all. Keeping the hash on the error rather than only
 * inside the message is what lets the execution finalizer persist a structured
 * receipt for the failure instead of leaving the hash recoverable only by
 * parsing prose.
 *
 * The message is unchanged from the plain Error it replaces, so callers that
 * only read `error.message` (workflow steps, log lines) behave identically.
 */
export class OnChainRevertError extends Error {
  readonly kind = "onchain-revert" as const;
  readonly transactionHash: string;
  readonly blockNumber?: number;

  constructor(opts: {
    message: string;
    transactionHash: string;
    blockNumber?: number;
  }) {
    super(opts.message);
    this.name = "OnChainRevertError";
    this.transactionHash = opts.transactionHash;
    this.blockNumber = opts.blockNumber;
  }
}

export function isOnChainRevertError(
  error: unknown
): error is OnChainRevertError {
  return (
    error instanceof Error &&
    (error as OnChainRevertError).kind === "onchain-revert"
  );
}

/**
 * Recover the hash of a transaction that reached the chain and failed, from
 * whichever carrier the write path used. Returns undefined for pre-broadcast
 * failures, where there is nothing to reconcile.
 */
export function revertedTransactionHash(error: unknown): string | undefined {
  return isOnChainRevertError(error) ? error.transactionHash : undefined;
}

/**
 * Thrown when a directly-signed transaction was broadcast and then could not be
 * read back: `wait()` resolved without a receipt, or the Tempo receipt poll
 * lapsed before the chain answered.
 *
 * Mirrors SponsoredTxPendingError on the sponsored path. The distinction it
 * carries is the whole point: a transaction whose receipt we cannot read has
 * not failed. It is unknown, and it may still mine. Keeping the hash on the
 * error is what lets the finalizer settle the row as `unconfirmed` and hand it
 * to the reconciler, instead of stamping a terminal failure for a transaction
 * that exists on-chain and nowhere in our data.
 *
 * Callers MUST NOT retry on this error: the first send may still be landing,
 * and a retry would put a second transaction from the same wallet on-chain.
 *
 * The message is unchanged from the plain Error it replaces, so callers that
 * only read `error.message` behave identically.
 */
export class OnChainPendingError extends Error {
  readonly kind = "onchain-pending" as const;
  readonly transactionHash: string;

  constructor(opts: { message: string; transactionHash: string }) {
    super(opts.message);
    this.name = "OnChainPendingError";
    this.transactionHash = opts.transactionHash;
  }
}

export function isOnChainPendingError(
  error: unknown
): error is OnChainPendingError {
  return (
    error instanceof Error &&
    (error as OnChainPendingError).kind === "onchain-pending"
  );
}

/**
 * Recover the hash of a transaction that reached the chain, whatever its
 * outcome: reverted (conclusive) or unread (unknown). Returns undefined only
 * for pre-broadcast failures, where no transaction exists.
 *
 * Prefer this over `revertedTransactionHash` at the write-path boundary. The
 * two differ exactly where it matters: a reverted transaction is a settled
 * failure, an unread one is not settled at all, and both need their hash
 * persisted for the record to be complete.
 */
export function broadcastTransactionHash(error: unknown): string | undefined {
  if (isOnChainRevertError(error)) {
    return error.transactionHash;
  }
  return isOnChainPendingError(error) ? error.transactionHash : undefined;
}
