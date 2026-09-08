import "server-only";

// Server-only helpers that bridge the feature registry with org plan lookup.
// Pure check functions live in ./check.ts so the client can reuse them.

import { getOrgPlan } from "@/lib/billing/plans-server";
import { isFeatureEnabled } from "./check";
import type { FeatureId, WorkflowNodeRef } from "./types";
import { validateWorkflowFeatures } from "./workflow-validator";

export async function isFeatureEnabledForOrg(
  featureId: FeatureId,
  organizationId: string
): Promise<boolean> {
  const plan = await getOrgPlan(organizationId);
  return isFeatureEnabled(featureId, plan);
}

export async function validateWorkflowFeaturesForOrg(
  nodes: readonly WorkflowNodeRef[],
  organizationId: string
): Promise<ReturnType<typeof validateWorkflowFeatures>> {
  const plan = await getOrgPlan(organizationId);
  return validateWorkflowFeatures(nodes, plan);
}
