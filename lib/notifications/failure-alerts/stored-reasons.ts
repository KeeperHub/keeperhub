/** Why a delivery was not sent: stored in alert_deliveries.last_error and matched later, so change a value only with its rows. */
export const SKIP_REASON = {
  success: "The workflow recovered before this was delivered.",
  ran: "The workflow ran before this was delivered.",
  disabled: "The workflow was turned off before this was delivered.",
  deleted: "The workflow was deleted before this was delivered.",
  manual_trigger:
    "The workflow was switched to a manual trigger before this was delivered.",
  failedAgain: "The workflow failed again before this was sent.",
  halted: "Not sent: the organization's circuit breaker was engaged.",
  stale: "Dropped: not sent within an hour of being due.",
  gone: "What this message was about no longer exists.",
} as const;
