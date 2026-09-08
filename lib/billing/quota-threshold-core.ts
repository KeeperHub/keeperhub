/**
 * Pure core of the execution-quota signal: thresholds and the arithmetic that
 * turns a counted usage figure into a status. No database and no server-only
 * imports, so admission can reach it without pulling in the query layer it
 * already lives in. The DB-backed readers are in ./quota-threshold.
 */

import {
  effectiveExecutionLimit,
  startOfCurrentMonthUtc,
} from "./execution-limit-core";
import { isBillingEnabled } from "./feature-flag";
import {
  getPlanDisplayName,
  getPlanLimits,
  PAYG_PLAN_NAME,
  PLANS,
  type PlanLimits,
  type PlanName,
  type TierKey,
} from "./plans";

/**
 * The single backend signal behind both the quota warning email and the
 * in-app quota banner. Keeping one module compute it is what stops the two
 * from drifting: the cron reads it in bulk for every active org, the banner
 * endpoint reads it for one org, and both get the same percentage.
 *
 * The window is the UTC calendar month, matching admission
 * (execution-limit-core.startOfCurrentMonthUtc) rather than the Stripe billing
 * cycle, so an org is warned against the limit that will actually refuse it.
 */

/** Evaluated high to low; the first match is the threshold an org has reached. */
export const QUOTA_THRESHOLDS = [100, 80] as const;

export type QuotaThreshold = (typeof QUOTA_THRESHOLDS)[number];

/** Below this, an org is not a candidate and never reaches a per-org query. */
export const LOWEST_QUOTA_THRESHOLD: QuotaThreshold =
  QUOTA_THRESHOLDS.at(-1) ?? 80;

export function crossedQuotaThreshold(
  usagePercent: number
): QuotaThreshold | null {
  for (const threshold of QUOTA_THRESHOLDS) {
    if (usagePercent >= threshold) {
      return threshold;
    }
  }
  return null;
}

export type QuotaStatus = {
  organizationId: string;
  plan: PlanName;
  planLabel: string;
  /** Billable executions counted in the current UTC month. */
  used: number;
  /** Included limit reduced by active debt, the number that actually gates. */
  limit: number;
  /** Plan/tier included limit before debt is applied. */
  includedLimit: number;
  debtExecutions: number;
  /** Floored so a displayed 80% and a fired 80% notification always agree. */
  usagePercent: number;
  threshold: QuotaThreshold | null;
  periodStart: Date;
  /** Exclusive: when the count resets to zero. */
  periodEnd: Date;
  /** Org can keep running past the limit by paying per execution. */
  paygEligible: boolean;
  /** Dollars per 1,000 executions past the limit, or null when not billed. */
  overageRatePerThousand: number | null;
};

function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Turn a counted usage figure into a quota status. No DB access, so both the
 * bulk cron path and the single-org path share the arithmetic.
 *
 * Returns null for unlimited plans, which have no percentage to report.
 */
export function buildQuotaStatus(params: {
  organizationId: string;
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null | undefined;
  used: number;
  debtExecutions: number;
  now?: Date;
}): QuotaStatus | null {
  const now = params.now ?? new Date();
  const limits = getPlanLimits(params.plan, params.tier, params.planOverrides);
  const includedLimit = limits.maxExecutionsPerMonth;

  if (includedLimit < 0) {
    return null;
  }

  const limit = effectiveExecutionLimit(includedLimit, params.debtExecutions);
  const usagePercent =
    limit > 0 ? Math.floor((params.used / limit) * 100) : 100;
  const planDef = PLANS[params.plan];

  return {
    organizationId: params.organizationId,
    plan: params.plan,
    planLabel: getPlanDisplayName(params.plan),
    used: params.used,
    limit,
    includedLimit,
    debtExecutions: params.debtExecutions,
    usagePercent,
    threshold: crossedQuotaThreshold(usagePercent),
    periodStart: startOfCurrentMonthUtc(now),
    periodEnd: startOfNextMonthUtc(now),
    paygEligible: params.plan === PAYG_PLAN_NAME && isBillingEnabled(),
    overageRatePerThousand: planDef.overage.enabled
      ? planDef.overage.ratePerThousand
      : null,
  };
}
