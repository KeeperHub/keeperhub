/**
 * Minimum price (USDC per call) at which a successful Marketplace payment
 * makes that execution exempt from the owner's monthly execution quota and
 * overage invoicing.
 *
 * The exemption is gated on actual payment receipt, not on the workflow's
 * listing state alone:
 *
 *   billable = TRUE by default on every workflow_executions insert; the
 *   marketplace call route flips it to FALSE only after `recordPayment`
 *   succeeds and the recorded price is at or above this threshold. Owner-
 *   initiated runs (manual Run, scheduled, block, event, webhook, direct
 *   API) never reach that flip and always count toward the quota.
 *
 * Why a floor exists: without one, an owner could publish a workflow at $0
 * (or any irrationally low price), self-call it through the marketplace,
 * and accumulate "free" executions while bypassing their plan limit.
 *
 * See drizzle/0070_workflow_executions_billable.sql for the column
 * definition and app/api/mcp/workflows/[slug]/call/route.ts for the flip.
 *
 * Stored as a string because USDC prices are persisted as Postgres `numeric`
 * and read back into TS as strings; keeping the threshold a string avoids
 * implicit float coercion at the constant-definition site. Use
 * {@link priceQualifiesForMarketplaceExemption} for comparisons rather than
 * coercing this value at every call site.
 */
export const FREE_MARKETPLACE_BILLING_THRESHOLD_USDC = "0.05";

/**
 * Whether a successful Marketplace payment at the given listing price
 * qualifies for the execution-quota exemption.
 *
 * Returns true if the recorded price is at or above
 * FREE_MARKETPLACE_BILLING_THRESHOLD_USDC. Treats null / undefined / empty
 * as 0 (does not qualify), which matches how Postgres COALESCE handles a
 * missing price.
 *
 * NOTE: callers in the marketplace call route currently pass
 * `workflow.priceUsdcPerCall` (the listing price loaded with the request)
 * as a stand-in for "amount actually paid". This is correct today because
 * the upstream payment gate validates the signature against the listing
 * price, so signature-mismatch traffic never reaches this branch. If that
 * gate ever loosens (partial payments, dynamic pricing, refunds), this
 * helper should be invoked with the verified payment amount instead.
 */
export function priceQualifiesForMarketplaceExemption(
  priceUsdcPerCall: string | null | undefined
): boolean {
  const price = Number(priceUsdcPerCall ?? 0);
  return price >= Number(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC);
}
