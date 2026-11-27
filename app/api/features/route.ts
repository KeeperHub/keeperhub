import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgPlan } from "@/lib/billing/plans-server";
import { buildFeatureSnapshot, getAllFeatures } from "@/lib/features";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type OrganizationAuthContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { isPythPriceTriggerEnabled } from "@/lib/pyth/feature-flag";
import { isRolloutActive } from "@/lib/rollout";
import { isBundleSendEnabledForOrg } from "@/lib/web3/bundles/rollout";

/** Whether the calling org may send bundles (BUNDLE_SEND_ROLLOUT); never the setting itself. */
async function bundleSendEnabled(
  request: Request,
  organizationId?: string
): Promise<boolean> {
  if (!isRolloutActive(process.env.BUNDLE_SEND_ROLLOUT)) {
    return false;
  }
  let orgId = organizationId;
  if (!orgId) {
    try {
      const resolved = await resolveOrganizationId(request);
      orgId = "error" in resolved ? undefined : resolved.organizationId;
    } catch {
      // No org to check: the editor does not offer bundles.
      return false;
    }
  }
  return orgId !== undefined && isBundleSendEnabledForOrg(orgId);
}

// Returns the feature snapshot for the calling org so the UI can render
// per-plan lock states without re-implementing the registry client-side.
// When billing is disabled (self-hosted / local dev) every feature is open.
export async function GET(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({
      plan: "enterprise" as const,
      enabledFeatureIds: getAllFeatures().map((f) => f.id),
      features: getAllFeatures(),
      billingEnabled: false,
      pythPriceTriggerEnabled: isPythPriceTriggerEnabled(),
      bundleSendEnabled: await bundleSendEnabled(request),
    });
  }

  let authContext: OrganizationAuthContext | null = null;
  try {
    authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { organizationId } = authContext;

    const plan = await getOrgPlan(organizationId);

    return NextResponse.json({
      ...buildFeatureSnapshot(plan),
      billingEnabled: true,
      pythPriceTriggerEnabled: isPythPriceTriggerEnabled(),
      bundleSendEnabled: await bundleSendEnabled(request, organizationId),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Features] Snapshot query error",
      error,
      {
        endpoint: "/api/features",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch features" },
      { status: 500 }
    );
  }
}
