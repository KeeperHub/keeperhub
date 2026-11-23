import "server-only";

// Plan gate for a single action at the moment it runs. The step wrapper calls
// this for every step, so a gated action is refused for an org without the
// required plan no matter which route or trigger dispatched it.

import { isBillingEnabled } from "@/lib/billing/feature-flag";
import type { PlanName } from "@/lib/billing/plans";
import { getOrgPlan } from "@/lib/billing/subscription-read";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { resolveActionFeature } from "./action-egress";
import { isFeatureEnabled } from "./check";
import type { FeatureDefinition, FeatureId } from "./types";

export const FEATURE_UPGRADE_REQUIRED_ERROR =
  "This workflow uses features that require a paid plan.";

export type ActionPlanGateBlock = {
  success: false;
  error: string;
  code: "upgrade_required";
  featureId: FeatureId;
  requiredPlan: PlanName;
};

function gatedFeatures(
  actionTypes: readonly (string | undefined)[]
): FeatureDefinition[] {
  const features = new Map<FeatureId, FeatureDefinition>();
  for (const actionType of actionTypes) {
    if (!actionType) {
      continue;
    }
    const feature = resolveActionFeature(actionType);
    if (feature) {
      features.set(feature.id, feature);
    }
  }
  return [...features.values()];
}

/**
 * Returns a failed step result when any of the given action types is gated
 * beyond the org's plan, or null when the action may run. Every identity the
 * caller has for the action is passed so a mislabelled one cannot slip past.
 * The plan is read only when an action type is actually gated.
 */
export async function checkActionPlanGate(
  actionTypes: readonly (string | undefined)[],
  organizationId: string | undefined
): Promise<ActionPlanGateBlock | null> {
  if (!isBillingEnabled()) {
    return null;
  }

  const features = gatedFeatures(actionTypes);
  if (features.length === 0) {
    return null;
  }

  // Default-deny: no org context means no paid plan to read.
  const plan: PlanName = organizationId
    ? await getOrgPlan(organizationId)
    : "free";
  const denied = features.find((f) => !isFeatureEnabled(f.id, plan));
  if (!denied) {
    return null;
  }

  logSystemWarn(
    ErrorCategory.BILLING,
    "[PlanGate] Refused a gated action for an org without the required plan",
    undefined,
    {
      feature_id: denied.id,
      plan,
      ...(organizationId ? { organization_id: organizationId } : {}),
    }
  );

  return {
    success: false,
    error: `${FEATURE_UPGRADE_REQUIRED_ERROR} ${denied.name} requires an upgrade.`,
    code: "upgrade_required",
    featureId: denied.id,
    requiredPlan: denied.requiredPlan,
  };
}
