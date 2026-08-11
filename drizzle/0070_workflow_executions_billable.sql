-- Whether a workflow execution counts toward the owner org's monthly
-- execution quota and overage billing.
--
-- Apply prospectively: the column defaults to TRUE so historical plan-quota
-- usage is preserved exactly. The exemption is opt-out, not opt-in: every
-- insert path defaults to billable=TRUE (counted toward quota), and the
-- marketplace payment gate is the only thing that flips a row to FALSE,
-- after it verifies an x402 / MPP payment at or above the
-- FREE_MARKETPLACE_BILLING_THRESHOLD_USDC threshold (see
-- app/api/mcp/workflows/[slug]/call/route.ts and
-- lib/billing/marketplace-billing.ts).
--
-- An earlier draft of this migration installed a BEFORE INSERT trigger that
-- computed billable from the workflow's listing state. That checked the
-- wrong invariant: an owner could list at the threshold price and click Run
-- repeatedly to get free quota credits, since the trigger fired on any
-- insert, not just on paid marketplace calls. Tying the exemption to actual
-- payment receipt closes that loophole; the cost is that the marketplace
-- route is now responsible for flipping the flag.

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "billable" boolean NOT NULL DEFAULT TRUE;
