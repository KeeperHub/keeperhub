import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSubscriptions } from "@/lib/db/schema";
import { getActiveDebtExecutions } from "./execution-debt";
import {
  countMonthlyExecutionsForAdmission,
  decideExecutionLimit,
  effectiveExecutionLimit,
} from "./execution-limit-core";
import { isBillingEnabled } from "./feature-flag";
import {
  type BillingInterval,
  getPlanLimits,
  isValidPlanName,
  isValidTierKey,
  PLANS,
  type PlanLimits,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "./plans";

// -- Price ID mapping (server-only, env vars not available in client bundles) --

const PRICE_IDS: Record<string, string | undefined> = {
  pro_25k_monthly: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
  pro_25k_yearly: process.env.STRIPE_PRICE_PRO_25K_YEARLY,
  pro_50k_monthly: process.env.STRIPE_PRICE_PRO_50K_MONTHLY,
  pro_50k_yearly: process.env.STRIPE_PRICE_PRO_50K_YEARLY,
  pro_100k_monthly: process.env.STRIPE_PRICE_PRO_100K_MONTHLY,
  pro_100k_yearly: process.env.STRIPE_PRICE_PRO_100K_YEARLY,
  business_250k_monthly: process.env.STRIPE_PRICE_BUSINESS_250K_MONTHLY,
  business_250k_yearly: process.env.STRIPE_PRICE_BUSINESS_250K_YEARLY,
  business_500k_monthly: process.env.STRIPE_PRICE_BUSINESS_500K_MONTHLY,
  business_500k_yearly: process.env.STRIPE_PRICE_BUSINESS_500K_YEARLY,
  business_1m_monthly: process.env.STRIPE_PRICE_BUSINESS_1M_MONTHLY,
  business_1m_yearly: process.env.STRIPE_PRICE_BUSINESS_1M_YEARLY,
  enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
  enterprise_yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY,
};

export function getPriceId(
  plan: PlanName,
  tier: TierKey | null,
  interval: BillingInterval
): string | undefined {
  if (plan === "enterprise") {
    return PRICE_IDS[`enterprise_${interval}`];
  }
  if (tier === null) {
    return undefined;
  }
  return PRICE_IDS[`${plan}_${tier}_${interval}`];
}

type ResolvedPrice = {
  plan: PlanName;
  tier: TierKey | null;
  interval: BillingInterval | null;
};

function parseInterval(value: string | undefined): BillingInterval | null {
  return value === "monthly" || value === "yearly" ? value : null;
}

function parseKeyParts(parts: string[]): ResolvedPrice | undefined {
  const plan = parts[0];
  if (!isValidPlanName(plan)) {
    return undefined;
  }
  if (plan === "enterprise") {
    return { plan, tier: null, interval: parseInterval(parts[1]) };
  }
  const tier = isValidTierKey(parts[1]) ? parts[1] : null;
  return { plan, tier, interval: parseInterval(parts[2]) };
}

export function resolvePriceId(priceId: string): ResolvedPrice | undefined {
  for (const [key, value] of Object.entries(PRICE_IDS)) {
    if (value === priceId) {
      const result = parseKeyParts(key.split("_"));
      if (result !== undefined) {
        return result;
      }
    }
  }
  return undefined;
}

function resolveFromMetadata(
  metadata: Record<string, string> | undefined
): ResolvedPrice | undefined {
  const planValue = metadata?.plan;
  if (!isValidPlanName(planValue)) {
    return undefined;
  }
  const intervalValue = metadata?.interval;
  const interval = parseInterval(intervalValue);

  if (planValue === "enterprise") {
    return { plan: "enterprise", tier: null, interval };
  }

  const tier = parseTierKey(metadata?.tier);
  return { plan: planValue, tier, interval };
}

/**
 * Resolve a Stripe price to a (plan, tier, interval) tuple.
 *
 * Lookup order:
 * 1. Env-var price ID map (catalog plans: pro, business, standard enterprise)
 * 2. Subscription metadata (`plan`, `tier`, `interval`) — for custom enterprise prices
 * 3. Price metadata — fallback when subscription wasn't tagged
 *
 * Returns undefined if no signal can identify the plan; the caller logs and
 * leaves the subscription unchanged so a human can investigate.
 */
export function resolveSubscriptionPlan(
  priceId: string,
  metadata?: {
    subscription?: Record<string, string>;
    price?: Record<string, string>;
  }
): ResolvedPrice | undefined {
  const fromEnv = resolvePriceId(priceId);
  if (fromEnv) {
    return fromEnv;
  }
  return (
    resolveFromMetadata(metadata?.subscription) ??
    resolveFromMetadata(metadata?.price)
  );
}

export async function getOrgSubscription(
  organizationId: string
): Promise<typeof organizationSubscriptions.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, organizationId))
    .limit(1);
  return rows[0];
}

export async function getOrgPlan(organizationId: string): Promise<PlanName> {
  const sub = await getOrgSubscription(organizationId);
  if (!sub) {
    return "free";
  }
  return parsePlanName(sub.plan);
}

export async function checkFeatureAccess(
  organizationId: string,
  feature: keyof PlanLimits
): Promise<boolean> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const limits = getPlanLimits(
    plan,
    parseTierKey(sub?.tier),
    sub?.planOverrides
  );

  const value = limits[feature];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value !== "rate-limited";
  }
  return value !== null;
}

/** Within limits or unlimited plan -- no action needed. */
export type ExecutionWithinLimits = {
  allowed: true;
  isOverage: false;
  debtExecutions: number;
  effectiveLimit: number;
};

/** Paid plan exceeded its included limit -- execution proceeds, billed later. */
export type ExecutionOverageAllowed = {
  allowed: true;
  isOverage: true;
  limit: number;
  used: number;
  overageRate: number;
  debtExecutions: number;
  effectiveLimit: number;
};

/** Free plan limit exhausted -- execution must be blocked. */
export type ExecutionLimitExceeded = {
  allowed: false;
  limit: number;
  used: number;
  plan: PlanName;
  debtExecutions: number;
  effectiveLimit: number;
};

export type ExecutionLimitResult =
  | ExecutionWithinLimits
  | ExecutionOverageAllowed
  | ExecutionLimitExceeded;

/**
 * Check if an organization has exceeded its monthly execution limit.
 *
 * Returns one of:
 * - allowed + not overage (within limits or unlimited plan)
 * - allowed + overage (paid plan with overage enabled, will be billed later)
 * - not allowed (free plan limit exceeded)
 *
 * NOTE: This is a point-in-time check (TOCTOU). The caller does not hold a lock,
 * so concurrent requests may each pass the check before any execution is recorded.
 * The resulting overshoot is bounded by request concurrency and is acceptable:
 * paid plans are backstopped by overage billing, free plans by a small bounded excess.
 */
export async function checkExecutionLimit(
  organizationId: string
): Promise<ExecutionLimitResult> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);
  const limits = getPlanLimits(plan, tier, sub?.planOverrides);

  if (limits.maxExecutionsPerMonth === -1) {
    // Unlimited plans are unaffected by debt -- skip the query intentionally
    return {
      allowed: true,
      isOverage: false,
      debtExecutions: 0,
      effectiveLimit: -1,
    };
  }

  const debtExecutions = await getActiveDebtExecutions(organizationId);
  const effectiveLimit = effectiveExecutionLimit(
    limits.maxExecutionsPerMonth,
    debtExecutions
  );

  const planDef = PLANS[plan];
  const used = await countMonthlyExecutionsForAdmission(db, organizationId, {
    maxExecutionsPerMonth: limits.maxExecutionsPerMonth,
    overageEnabled: planDef.overage.enabled,
  });

  const outcome = decideExecutionLimit({
    maxExecutionsPerMonth: limits.maxExecutionsPerMonth,
    used,
    debtExecutions,
    overageEnabled: planDef.overage.enabled,
    subscriptionActive: sub?.status === "active",
  });

  switch (outcome) {
    // Under limit: always allowed, no overage.
    case "within_limit":
      return {
        allowed: true,
        isOverage: false,
        debtExecutions,
        effectiveLimit,
      };
    // Paid plans over limit: allowed with overage billing.
    case "overage":
      return {
        allowed: true,
        isOverage: true,
        limit: limits.maxExecutionsPerMonth,
        used,
        overageRate: planDef.overage.ratePerThousand,
        debtExecutions,
        effectiveLimit,
      };
    // Free plan at its included limit: allow the run so it can be charged
    // per-execution via x402 downstream. PAYG covers every free org, and the
    // charge (wallet balance and spend caps) is the real gate. With billing off
    // nothing downstream can charge, so the included limit is the gate again.
    case "blocked_limit":
      if (plan === "free" && isBillingEnabled()) {
        return {
          allowed: true,
          isOverage: false,
          debtExecutions,
          effectiveLimit,
        };
      }
      return {
        allowed: false,
        limit: limits.maxExecutionsPerMonth,
        used,
        plan,
        debtExecutions,
        effectiveLimit,
      };
    // blocked_debt (unpaid overage past grace) rejects.
    default:
      return {
        allowed: false,
        limit: limits.maxExecutionsPerMonth,
        used,
        plan,
        debtExecutions,
        effectiveLimit,
      };
  }
}
