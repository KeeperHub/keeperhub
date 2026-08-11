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
