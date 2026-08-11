import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  getPlanLimits,
  PLANS,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "./plans";
import { getOrgSubscription } from "./plans-server";
import { getTrialPeriodDays, isTrialOfferEligible } from "./trial";

// Free-plan usage (as a % of the free cap) at which we start nudging the org to
// begin a Pro trial. Lower than the paid-tier upgrade threshold since the goal
// is first conversion, not overage savings.
const TRIAL_NUDGE_USAGE_PERCENT = 50;

export type StartTrialSuggestion = {
  plan: "pro";
  trialDays: number;
  currentUsage: number;
  currentLimit: number;
  usagePercent: number;
};

export type UpgradeSuggestion =
  | { shouldUpgrade: false; startTrial?: StartTrialSuggestion }
  | {
      shouldUpgrade: true;
      currentPlan: PlanName;
      currentTier: TierKey | null;
      currentLimit: number;
      currentUsage: number;
      usagePercent: number;
      suggestedPlan: PlanName;
      suggestedTier: TierKey;
      suggestedLimit: number;
      monthlySavings: number;
    };

/**
 * Analyze current usage and suggest a tier upgrade if cost-effective.
 *
 * Returns a suggestion when:
 * - Usage exceeds 80% of the current limit
 * - A higher tier exists that would reduce projected overage costs
 */
export async function getUpgradeSuggestion(
  organizationId: string
): Promise<UpgradeSuggestion> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);
  const limits = getPlanLimits(plan, tier, sub?.planOverrides);

  if (limits.maxExecutionsPerMonth === -1) {
    return { shouldUpgrade: false };
  }

  const now = new Date();
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  const result = await db.execute<{ count: number }>(
    sql`SELECT
          (
            SELECT COUNT(*)
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${startOfMonth.toISOString()}
               AND we.billable = TRUE
          )
          +
          (
            SELECT COUNT(*)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${startOfMonth.toISOString()}
          ) AS count`
  );

  const currentUsage = result[0]?.count ?? 0;
  const usagePercent = (currentUsage / limits.maxExecutionsPerMonth) * 100;

  // Free-plan orgs never qualify for a savings-based tier upgrade (no overage),
  // so nudge engaged, trial-eligible free orgs to start a Pro trial instead.
  if (
    plan === "free" &&
    isTrialOfferEligible(sub) &&
    usagePercent >= TRIAL_NUDGE_USAGE_PERCENT
  ) {
    return {
      shouldUpgrade: false,
      startTrial: {
        plan: "pro",
        trialDays: getTrialPeriodDays(),
        currentUsage,
        currentLimit: limits.maxExecutionsPerMonth,
        usagePercent: Math.round(usagePercent),
      },
    };
  }

  if (usagePercent < 80) {
    return { shouldUpgrade: false };
  }

  // Project full-month usage based on days elapsed (UTC to match the query)
  const dayOfMonth = now.getUTCDate();
  if (dayOfMonth < 3) {
    // Too few days of data for a meaningful projection
    return { shouldUpgrade: false };
  }
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const projectedUsage = Math.ceil((currentUsage / dayOfMonth) * daysInMonth);

  // Find the best upgrade option across all plans and tiers
  const suggestion = findBestUpgrade(
    plan,
    tier,
    limits.maxExecutionsPerMonth,
    projectedUsage
  );

  if (!suggestion) {
    return { shouldUpgrade: false };
  }

  return {
    shouldUpgrade: true,
    currentPlan: plan,
    currentTier: tier,
    currentLimit: limits.maxExecutionsPerMonth,
    currentUsage,
    usagePercent: Math.round(usagePercent),
    suggestedPlan: suggestion.plan,
    suggestedTier: suggestion.tier,
    suggestedLimit: suggestion.limit,
    monthlySavings: suggestion.savings,
  };
}

type UpgradeOption = {
  plan: PlanName;
  tier: TierKey;
  limit: number;
  savings: number;
};

type PlanTierDef = (typeof PLANS)[PlanName]["tiers"][number];
type PlanDef = (typeof PLANS)[PlanName];

function calculateOverageCostCents(overage: number, planDef: PlanDef): number {
  if (!planDef.overage.enabled || overage <= 0) {
    return 0;
  }
  const perExecutionCents = (planDef.overage.ratePerThousand * 100) / 1000;
  return Math.round(overage * perExecutionCents);
}

function calculateTierSavings(
  tierDef: PlanTierDef,
  planDef: PlanDef,
  projectedUsage: number,
  currentTotalCost: number
): number {
  const tierOverage = Math.max(0, projectedUsage - tierDef.executions);
  const overageCost = calculateOverageCostCents(tierOverage, planDef);
  const totalNewCost = tierDef.monthlyPrice * 100 + overageCost;
  return currentTotalCost - totalNewCost;
}

function findBestUpgrade(
  currentPlan: PlanName,
  currentTier: TierKey | null,
  currentLimit: number,
  projectedUsage: number
): UpgradeOption | undefined {
  const currentPlanDef = PLANS[currentPlan];
  const projectedOverage = Math.max(0, projectedUsage - currentLimit);

  if (projectedOverage === 0) {
    return undefined;
  }

  const currentOverageCost = calculateOverageCostCents(
    projectedOverage,
    currentPlanDef
  );
  const currentTierDef = currentPlanDef.tiers.find(
    (t) => t.key === currentTier
  );
  const currentTotalCost =
    (currentTierDef?.monthlyPrice ?? 0) * 100 + currentOverageCost;

  const plansToCheck: PlanName[] = ["pro", "business"];

  // Collect all upgrade options that save money, sorted by tier size ascending.
  // We prefer the smallest tier that covers projected usage (cheapest logical
  // next step) rather than the tier with the absolute highest savings.
  const candidates: UpgradeOption[] = [];

  for (const planName of plansToCheck) {
    const planDef = PLANS[planName];

    for (const tierDef of planDef.tiers) {
      if (tierDef.executions <= currentLimit) {
        continue;
      }

      const savings = calculateTierSavings(
        tierDef,
        planDef,
        projectedUsage,
        currentTotalCost
      );

      if (savings > 0) {
        candidates.push({
          plan: planName,
          tier: tierDef.key,
          limit: tierDef.executions,
          savings: Math.round(savings),
        });
      }
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  // Prefer same-plan tier upgrades over cross-plan jumps.
  // Within each group, pick the smallest tier that covers projected usage.
  const samePlan = candidates
    .filter((c) => c.plan === currentPlan)
    .sort((a, b) => a.limit - b.limit);
  const crossPlan = candidates
    .filter((c) => c.plan !== currentPlan)
    .sort((a, b) => a.limit - b.limit);

  const samePlanMatch =
    samePlan.find((c) => c.limit >= projectedUsage) ?? samePlan[0];
  if (samePlanMatch) {
    return samePlanMatch;
  }

  const crossPlanMatch =
    crossPlan.find((c) => c.limit >= projectedUsage) ?? crossPlan[0];
  return crossPlanMatch;
}
