// Reason a PAYG execution was blocked. Drives the guard HTTP body, the blocked
// run's error record, and the billing UI, so the user knows exactly why a run
// did not execute and what to do about it.
export type PaygBlockReason =
  | "insufficient_funds"
  | "daily_cap"
  | "period_cap"
  | "payment_failed"
  | "not_eligible";

export const PAYG_BLOCK_MESSAGES: Record<PaygBlockReason, string> = {
  insufficient_funds:
    "Not enough USDC in your wallet to cover this execution. Top up USDC on Base to keep running.",
  daily_cap:
    "Daily pay-as-you-go spend limit reached. Raise your daily limit or wait until tomorrow.",
  period_cap:
    "Pay-as-you-go spend limit for this period reached. Raise your limit to keep running.",
  payment_failed:
    "Pay-as-you-go payment could not be processed right now. Please try again shortly.",
  not_eligible:
    "Pay-as-you-go is not fully set up for this organization. Check your wallet and spend limits.",
};

export function paygBlockMessage(reason: PaygBlockReason): string {
  return PAYG_BLOCK_MESSAGES[reason];
}
