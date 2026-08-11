import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getUpgradeSuggestion } from "@/lib/billing/tier-suggestions";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type OrganizationAuthContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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

    const suggestion = await getUpgradeSuggestion(organizationId);
    return NextResponse.json(suggestion);
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Usage suggestion error",
      error,
      {
        endpoint: "/api/billing/usage-suggestion",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch usage suggestion" },
      { status: 500 }
    );
  }
}
