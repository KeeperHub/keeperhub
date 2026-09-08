// Pure feature-gating checks. No DB access — safe for client + server.
// Combine with getOrgPlan() server-side via lib/features/server.ts.

import type { PlanName } from "@/lib/billing/plans";
import { FEATURES, getAllFeatures } from "./registry";
import type { FeatureDefinition, FeatureId } from "./types";

// Plans are monotonically ordered. A user on a plan with rank >= the
// required-plan rank has access (subject to the master `enabled` flag).
const PLAN_RANK: Record<PlanName, number> = {
  free: 0,
  pro: 1,
  business: 2,
  enterprise: 3,
} as const;

export function planMeetsRequirement(
  plan: PlanName,
  requiredPlan: PlanName
): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[requiredPlan];
}

/** Highest plan tier among a set of required plans (for multi-feature violations). */
export function highestRequiredPlan(plans: readonly PlanName[]): PlanName {
  let highest: PlanName = plans[0] ?? "free";
  for (const plan of plans) {
    if (PLAN_RANK[plan] > PLAN_RANK[highest]) {
      highest = plan;
    }
  }
  return highest;
}

export function isFeatureEnabled(
  featureId: FeatureId,
  plan: PlanName
): boolean {
  const feature = FEATURES[featureId];
  if (!feature.enabled) {
    return false;
  }
  return planMeetsRequirement(plan, feature.requiredPlan);
}

export function getEnabledFeatureIdsForPlan(plan: PlanName): FeatureId[] {
  const enabled: FeatureId[] = [];
  for (const feature of getAllFeatures()) {
    if (isFeatureEnabled(feature.id, plan)) {
      enabled.push(feature.id);
    }
  }
  return enabled;
}

export type FeatureSnapshotForClient = {
  plan: PlanName;
  enabledFeatureIds: FeatureId[];
  features: readonly FeatureDefinition[];
};

export function buildFeatureSnapshot(plan: PlanName): FeatureSnapshotForClient {
  return {
    plan,
    enabledFeatureIds: getEnabledFeatureIdsForPlan(plan),
    features: getAllFeatures(),
  };
}
