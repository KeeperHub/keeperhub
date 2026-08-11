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
