import "server-only";

// Shared route guard that returns a 402 NextResponse with violation details
// when a workflow contains nodes whose feature is gated for the org's plan.
// Used by save, execute, and webhook routes so the wire-format is consistent.

import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgPlan } from "@/lib/billing/plans-server";
import type { WorkflowFeatureViolation, WorkflowNodeRef } from "./types";
import { validateWorkflowFeatures } from "./workflow-validator";

type GuardAllowed = { blocked: false };
type GuardBlocked = { blocked: true; response: NextResponse };
export type FeatureGuardResult = GuardAllowed | GuardBlocked;

export const FEATURE_UPGRADE_REQUIRED_ERROR =
  "This workflow uses features that require a paid plan.";

function buildBlockedResponse(
  violations: readonly WorkflowFeatureViolation[],
  errorMessage: string
): NextResponse {
  return NextResponse.json(
    {
      error: errorMessage,
      code: "upgrade_required",
      violations: violations.map((v) => ({
        featureId: v.featureId,
        featureName: v.feature.name,
        requiredPlan: v.feature.requiredPlan,
        actionType: v.actionType,
        nodeIds: v.nodeIds,
      })),
    },
    { status: 402 }
  );
}

type EnforceOptions = {
  // Override the default user-facing error string in the 402 body. The
  // `violations` array still carries the structured detail, but a custom
  // message lets a route like /claim explain the destination-org context.
  errorMessage?: string;
};

export async function enforceWorkflowFeatures(
  nodes: readonly WorkflowNodeRef[],
  organizationId: string | null | undefined,
  options?: EnforceOptions
): Promise<FeatureGuardResult> {
  // Billing disabled (e.g. local dev or self-hosted): never block.
  if (!isBillingEnabled()) {
    return { blocked: false };
  }

  // Default-deny: anonymous / system callers with no org context have no
  // paid plan we can read, so they are treated as free. If the workflow
  // contains any gated nodes, block — never trust the upstream auth layer
  // to have done the gating for us.
  const plan = organizationId ? await getOrgPlan(organizationId) : "free";
  const violations = validateWorkflowFeatures(nodes, plan);
  if (violations.length === 0) {
    return { blocked: false };
  }

  const errorMessage = options?.errorMessage ?? FEATURE_UPGRADE_REQUIRED_ERROR;
  return {
    blocked: true,
    response: buildBlockedResponse(violations, errorMessage),
  };
}
