import "server-only";

import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { autopayForExecution } from "./autopay";
import { type PaygBlockReason, paygBlockMessage } from "./errors";

export type PaygChargeResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: PaygBlockReason; message: string };

export type PaygChargeMaybe =
  | { applicable: false }
  | ({ applicable: true } & PaygChargeResult);

/**
 * Charge an execution only if it is billable under PAYG.
 *
 * `paygOverflow` is the verdict `checkExecutionLimit` already reached before
 * this run's row was written: the org is on the free plan and its included
 * monthly executions were spent before this one. The gate cannot re-derive that here, because the row for the
 * run being decided is committed by now and a fresh count would include it,
 * charging the last execution the plan includes. Everything else returns
 * `applicable: false` and is not charged.
 */
export async function chargePaygIfBillable(params: {
  organizationId: string;
  executionId: string;
  paygOverflow: boolean;
}): Promise<PaygChargeMaybe> {
  // With billing off there is no UI to read or set spend caps, so never move
  // money: the run proceeds unbilled rather than being blocked.
  if (!(isBillingEnabled() && params.paygOverflow)) {
    return { applicable: false };
  }
  const result = await chargePaygExecution(params);
  return { applicable: true, ...result };
}

/**
 * Charge one PAYG execution and return a caller-agnostic result: the settled tx
 * hash on success, or a block reason plus its user-facing message on failure.
 * Call this only for orgs already known to be on the PAYG plan, at the single
 * point the execution actually runs (the executor for enqueued runs, the
 * direct-execute routes for inline runs) so each execution settles exactly once.
 */
export async function chargePaygExecution(params: {
  organizationId: string;
  executionId: string;
}): Promise<PaygChargeResult> {
  const result = await autopayForExecution(params);
  if (result.ok) {
    return { ok: true, txHash: result.txHash };
  }
  return {
    ok: false,
    reason: result.reason,
    message: paygBlockMessage(result.reason),
  };
}
