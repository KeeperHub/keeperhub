import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgSubscription } from "@/lib/billing/plans-server";
import { getBillingProvider } from "@/lib/billing/providers";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const authResult = await requireOrgOwner();
    if ("error" in authResult) {
      return authResult.error;
    }
    const { orgId: activeOrgId } = authResult;

    const sub = await getOrgSubscription(activeOrgId);
    if (!sub?.providerCustomerId) {
      return NextResponse.json({
        paymentMethod: null,
        billingEmail: null,
      });
    }

    const provider = getBillingProvider();
    const details = await provider.getBillingDetails(sub.providerCustomerId);

    return NextResponse.json(details);
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Billing details error",
      error,
      { endpoint: "/api/billing/billing-details", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to load billing details" },
      { status: 500 }
    );
  }
}
