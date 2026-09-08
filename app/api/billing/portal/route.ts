import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgSubscription } from "@/lib/billing/plans-server";
import { getBillingProvider } from "@/lib/billing/providers";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import { resolveReturnUrl } from "@/lib/billing/return-url";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function POST(request: Request): Promise<NextResponse> {
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
      return NextResponse.json(
        {
          error: "No billing account found. Please subscribe to a plan first.",
        },
        { status: 400 }
      );
    }

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.BETTER_AUTH_URL ??
      "http://localhost:3000";
    const provider = getBillingProvider();

    const body = (await request.json().catch(() => null)) as {
      returnPath?: unknown;
    } | null;

    const { url } = await provider.createPortalSession(
      sub.providerCustomerId,
      resolveReturnUrl(appUrl, body?.returnPath)
    );

    return NextResponse.json({ url });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Portal error",
      error,
      { endpoint: "/api/billing/portal", operation: "post" }
    );
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500 }
    );
  }
}
