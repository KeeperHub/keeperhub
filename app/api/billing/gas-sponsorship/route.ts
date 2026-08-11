import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getMonthlySponsorship } from "@/lib/billing/gas-sponsorship-history";
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
    const { organizationId: activeOrgId } = authContext;

    const includeTestnets =
      new URL(request.url).searchParams.get("includeTestnets") === "true";

    const months = await getMonthlySponsorship(activeOrgId, {
      includeTestnets,
    });

    return NextResponse.json({ months });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Gas sponsorship history query error",
      error,
      {
        endpoint: "/api/billing/gas-sponsorship",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch gas sponsorship history" },
      { status: 500 }
    );
  }
}
