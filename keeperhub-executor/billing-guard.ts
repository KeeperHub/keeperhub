import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  countMonthlyExecutionsForAdmission,
  decideExecutionLimit,
  effectiveExecutionLimit,
  statusAllowsOverage,
} from "../lib/billing/execution-limit-core";
import {
  getPlanLimits,
  PLANS,
  type PlanName,
  parsePlanName,
  parseTierKey,
} from "../lib/billing/plans";
import { PAYG_OVERFLOW_REASON } from "../lib/billing/payg/constants";
import { executionDebt, organizationSubscriptions } from "../lib/db/schema";

export type BillingGuardResult =
  | {
      allowed: true;
      reason:
        | "billing_disabled"
        | "no_org"
        | "unlimited"
        | "within_limit"
        | "overage_billed"
        | typeof PAYG_OVERFLOW_REASON;
    }
  | {
      allowed: false;
      reason: "free_limit_exceeded" | "inactive_subscription" | "active_debt";
      plan: PlanName;
      used: number;
      limit: number;
      debtExecutions: number;
      effectiveLimit: number;
    };

function isBillingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";
}

/**
 * Mirrors lib/billing/plans-server.ts#checkExecutionLimit but without the
 * `import "server-only"` constraint so it can run in the standalone executor
 * process. The result determines whether a workflow execution row should be
 * created for an SQS-triggered run (schedule, block, event).
 */
export async function checkExecutionLimitForExecutor(
  db: PostgresJsDatabase<Record<string, unknown>>,
  organizationId: string | null | undefined
): Promise<BillingGuardResult> {
  if (!isBillingEnabled()) {
    return { allowed: true, reason: "billing_disabled" };
  }

  if (!organizationId) {
    return { allowed: true, reason: "no_org" };
  }

  const [sub] = await db
    .select({
      plan: organizationSubscriptions.plan,
      tier: organizationSubscriptions.tier,
      status: organizationSubscriptions.status,
      planOverrides: organizationSubscriptions.planOverrides,
    })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, organizationId))
    .limit(1);

  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);
  const limits = getPlanLimits(plan, tier, sub?.planOverrides);
  const planDef = PLANS[plan];

  if (limits.maxExecutionsPerMonth === -1) {
    return { allowed: true, reason: "unlimited" };
  }

  const debtRows = await db
    .select({ debt: executionDebt.debtExecutions })
    .from(executionDebt)
    .where(
      and(
        eq(executionDebt.organizationId, organizationId),
        eq(executionDebt.status, "active")
      )
    );
  const debtExecutions = debtRows.reduce((sum, r) => sum + (r.debt ?? 0), 0);
  const effectiveLimit = effectiveExecutionLimit(
    limits.maxExecutionsPerMonth,
    debtExecutions
  );

  const used = await countMonthlyExecutionsForAdmission(db, organizationId, {
    maxExecutionsPerMonth: limits.maxExecutionsPerMonth,
    overageEnabled: planDef.overage.enabled,
  });

  const outcome = decideExecutionLimit({
    maxExecutionsPerMonth: limits.maxExecutionsPerMonth,
    used,
    debtExecutions,
    overageEnabled: planDef.overage.enabled,
    statusAllowsOverage: statusAllowsOverage(sub?.status),
  });

  switch (outcome) {
    case "within_limit":
      return { allowed: true, reason: "within_limit" };
    case "overage":
      return { allowed: true, reason: "overage_billed" };
    case "blocked_debt":
      return {
        allowed: false,
        reason: "active_debt",
        plan,
        used,
        limit: limits.maxExecutionsPerMonth,
        debtExecutions,
        effectiveLimit,
      };
    default: {
      // Free plan at its included limit: admit and let the executor charge the
      // per-execution price before the run (the charge is the real gate). PAYG
      // covers every free org, so an org with no config row runs on the default
      // caps rather than being blocked. Matches checkExecutionLimit.
      if (plan === "free") {
        return { allowed: true, reason: PAYG_OVERFLOW_REASON };
      }
      return {
        allowed: false,
        reason: "free_limit_exceeded",
        plan,
        used,
        limit: limits.maxExecutionsPerMonth,
        debtExecutions,
        effectiveLimit,
      };
    }
  }
}
