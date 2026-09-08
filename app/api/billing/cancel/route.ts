import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgSubscription } from "@/lib/billing/plans-server";
import { getBillingProvider } from "@/lib/billing/providers";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import { db } from "@/lib/db";
import { organizationSubscriptions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const authResult = await requireOrgOwner();
    if ("error" in authResult) {
      return authResult.error;
    }
    const { orgId: activeOrgId, userId } = authResult;

    const sub = await getOrgSubscription(activeOrgId);

    if (!sub?.providerSubscriptionId || sub.plan === "free") {
      return NextResponse.json(
        { error: "No active subscription to cancel" },
        { status: 400 }
      );
    }

    const provider = getBillingProvider();
    const { periodEnd } = await provider.cancelSubscription(
      sub.providerSubscriptionId
    );

    await db
      .update(organizationSubscriptions)
      .set({
        cancelAtPeriodEnd: true,
        updatedAt: new Date(),
      })
      .where(eq(organizationSubscriptions.organizationId, activeOrgId));

    // Intent record: which user requested cancellation. The authoritative
    // subscription.canceled event is emitted by the Stripe webhook handler
    // when the subscription actually ends.
    await recordAuditEvent({
      actor: { userId, organizationId: activeOrgId, authMethod: "session" },
      action: "subscription.cancel_requested",
      resourceType: "subscription",
      resourceId: activeOrgId,
      before: { plan: sub.plan, cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
      after: { cancelAtPeriodEnd: true },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      canceled: true,
      periodEnd: periodEnd?.toISOString() ?? null,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Cancel error",
      error,
      { endpoint: "/api/billing/cancel", operation: "post" }
    );
    return NextResponse.json(
      { error: "Failed to cancel subscription" },
      { status: 500 }
    );
  }
}
