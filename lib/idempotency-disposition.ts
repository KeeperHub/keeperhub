/** How a reserved idempotency record should settle once work returns. */
export type IdempotencyDisposition = "success" | "failed" | "release";

export type IdempotencyExecutionEvidence = {
  transactionHash?: string;
  sponsored?: boolean;
  broadcastAttempted?: boolean;
  rejection?: unknown;
};

/**
 * Certainty, not success, decides whether a key is released.
 *
 * Safety default: a hashless failure with no explicit evidence is ambiguous and
 * stays held. Definite pre-broadcast failures must carry evidence that nothing
 * was sent (`broadcastAttempted: false`) or a classified EVM rejection from the
 * preflight/staticCall path. Once a hash exists, `failed` means receipt
 * verification reached a conclusive terminal failure; `unconfirmed` always
 * remains held.
 */
export function dispositionForExecutionOutcome(
  status: "completed" | "failed" | "unconfirmed",
  evidence?: IdempotencyExecutionEvidence
): IdempotencyDisposition {
  if (status === "completed") {
    return "success";
  }
  if (status === "unconfirmed") {
    return "failed";
  }
  if (evidence?.transactionHash) {
    return "release";
  }
  if (evidence?.broadcastAttempted === true) {
    return "failed";
  }
  if (evidence?.broadcastAttempted === false) {
    return "release";
  }
  // A classified EVM revert is evidence that the call was rejected before a
  // transaction was broadcast. This is the #1840 repro: staticCall rejects a
  // temporarily-false precondition, so the same logical key must be reusable.
  if (evidence?.rejection !== undefined) {
    return "release";
  }
  // Sponsored providers may know that submission was attempted before a hash
  // is available. If they do not provide explicit broadcastAttempted evidence,
  // fail closed rather than risk a second send.
  if (evidence?.sponsored === true) {
    return "failed";
  }
  return "failed";
}
