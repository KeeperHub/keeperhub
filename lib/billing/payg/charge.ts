import "server-only";

import { countMonthlyExecutionsForAdmission } from "@/lib/billing/execution-limit-core";
import {
  getPlanLimits,
  PLANS,
  parsePlanName,
  parseTierKey,
} from "@/lib/billing/plans";
import { getOrgSubscription } from "@/lib/billing/plans-server";
import { db } from "@/lib/db";
import { autopayForExecution } from "./autopay";
import { getPaygConfig } from "./config-store";
import { type PaygBlockReason, paygBlockMessage } from "./errors";

export type PaygChargeResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: PaygBlockReason; message: string };

export type PaygChargeMaybe =
  | { applicable: false }
  | ({ applicable: true } & PaygChargeResult);

/**
 * Charge an execution only if it is billable under PAYG: the org is on the free
 * plan, has PAYG enabled, and has already used its included monthly executions.
 * For the inline direct-execute routes, which do not know the billing state at
 * the charge point. Executions within the free bucket, non-free plans, and
 * PAYG-disabled orgs return `applicable: false` and are not charged.
 */
export async function chargePaygIfBillable(params: {
  organizationId: string;
  executionId: string;
}): Promise<PaygChargeMaybe> {
  const config = await getPaygConfig(params.organizationId);
  if (!config) {
    return { applicable: false };
  }
  const sub = await getOrgSubscription(params.organizationId);
  const plan = parsePlanName(sub?.plan);
  if (plan !== "free") {
    return { applicable: false };
  }
  const limits = getPlanLimits(
    plan,
    parseTierKey(sub?.tier),
    sub?.planOverrides
  );
  const used = await countMonthlyExecutionsForAdmission(
    db,
    params.organizationId,
    {
      maxExecutionsPerMonth: limits.maxExecutionsPerMonth,
      overageEnabled: PLANS[plan].overage.enabled,
    }
  );
  if (used < limits.maxExecutionsPerMonth) {
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
