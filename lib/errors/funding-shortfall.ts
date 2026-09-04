/**
 * Failures where the chain refused a transaction because the wallet paying for
 * it could not cover the cost.
 *
 * A shortfall is deterministic: the node read a balance and answered. Every
 * endpoint on the chain reads the same balance and answers the same way, and
 * so does the next attempt until the wallet is funded. That makes it the
 * author's to act on, never KeeperHub's, no matter which layer surfaces it or
 * what that layer wraps around it.
 *
 * Kept free of any import so the execution-error classifier and the send paths
 * that log these failures share one definition of the boundary.
 *
 * Covers every write path we run: EVM (Safe-routed writes and Tempo included,
 * both EVM underneath), where the node reports the shortfall against gas and
 * value; and Solana, where the runtime reports it against the fee, against
 * rent exemption, or as a debit on an account that was never credited.
 */
export const FUNDING_SHORTFALL_PATTERNS: readonly RegExp[] = [
  // EVM: geth's `insufficient funds for gas * price + value`, the
  // intrinsic-cost variant BNB Chain and friends return, and the ethers code
  // that accompanies both. Narrow on purpose: our own preflight string
  // (`Insufficient BNB balance. Have: ...`) has its own rule, so prose merely
  // containing the words does not land here.
  /insufficient funds for (gas|intrinsic transaction cost|transfer)/i,
  /code=INSUFFICIENT_FUNDS/,
  // Solana: the fee payer cannot cover the fee, cannot leave the account
  // rent-exempt, or has never been credited at all.
  /InsufficientFundsForRent|InsufficientFundsForFee/,
  /Attempt to debit an account but found no record of a prior credit/i,
  // Safe: the deploy path renders a shortfall into its own sentence before the
  // message leaves it, in two forms. The node's plain `insufficient funds`
  // becomes the first; a Safe that reverted on its own gas accounting becomes
  // the second, labelled by GS code.
  /no native balance to pay gas/i,
  /\(Safe error GS01[012]\)/,
];

/**
 * Whether a failure message reports a wallet that could not pay. Callers use
 * this to keep a funding shortfall out of platform alerting.
 */
export function isFundingShortfall(
  message: string | null | undefined
): boolean {
  if (!message) {
    return false;
  }
  return FUNDING_SHORTFALL_PATTERNS.some((pattern) => pattern.test(message));
}
