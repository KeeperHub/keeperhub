import type { PlanName } from "@/lib/billing/plans";
import { highestRequiredPlan } from "./check";
import {
  extractActionTypeNodes,
  validateWorkflowFeatures,
} from "./workflow-validator";

/**
 * Returns the minimum plan required to run a workflow on the free tier, or
 * null when no feature violations exist. Used by the public marketplace feed
 * to surface plan badges before a user duplicates a template.
 */
export function workflowRequiredPlan(
  nodes: readonly unknown[]
): PlanName | null {
  const violations = validateWorkflowFeatures(
    extractActionTypeNodes(nodes),
    "free"
  );
  if (violations.length === 0) {
    return null;
  }
  return highestRequiredPlan(violations.map((v) => v.feature.requiredPlan));
}
