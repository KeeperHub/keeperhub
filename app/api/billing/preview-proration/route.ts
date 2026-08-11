import { NextResponse } from "next/server";
import { PAID_PLANS, VALID_INTERVALS } from "@/lib/billing/constants";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import type { PlanName, TierKey } from "@/lib/billing/plans";
import { getOrgSubscription, getPriceId } from "@/lib/billing/plans-server";
import { getBillingProvider } from "@/lib/billing/providers";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import { isTrialPlan } from "@/lib/billing/trial";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { checkBillingRateLimit } from "../_lib/rate-limit";

type PreviewRequestBody = {
  plan?: string;
  tier?: string | null;
  interval?: string;
  // Keep-trial intent. Only the Manage-trial modal sets it; plan cards omit it,
  // so a trialing org previewing a card change sees the real charge.
  trial?: boolean;
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: HttpStatus.NOT_FOUND }
    );
  }

  try {
    const authResult = await requireOrgOwner();
    if ("error" in authResult) {
      return authResult.error;
    }
    const { orgId: activeOrgId } = authResult;

    const rateLimit = checkBillingRateLimit(activeOrgId);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        NextResponse.json(
          { error: "Too many billing requests. Please try again shortly." },
          { status: HttpStatus.TOO_MANY_REQUESTS }
        ),
        rateLimit
      );
    }

    const body = (await request.json()) as PreviewRequestBody;
    const { plan, tier, interval } = body;
    const trial = body.trial === true;

    if (!(plan && PAID_PLANS.has(plan))) {
      return NextResponse.json(
        { error: "Invalid plan" },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    if (!(interval && VALID_INTERVALS.has(interval))) {
      return NextResponse.json(
        { error: "Invalid interval" },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    const priceId = getPriceId(
      plan as PlanName,
      (tier ?? null) as TierKey | null,
      interval as "monthly" | "yearly"
    );

    if (!priceId) {
      return NextResponse.json(
        { error: "Price not found for selected plan" },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    const sub = await getOrgSubscription(activeOrgId);
    const existingSubId = sub?.providerSubscriptionId;

    if (!existingSubId || sub.status === "canceled" || sub.plan === "free") {
      return NextResponse.json({
        amountDue: 0,
        currency: "usd",
        periodEnd: null,
        lineItems: [],
      });
    }

    // Match the update: card changes (no trial intent) end a trial, so the
    // preview shows the real charge. Only the Manage-trial modal keeps it.
    const endTrial =
      sub.status === "trialing" &&
      !(
        trial && isTrialPlan(plan as PlanName, (tier ?? null) as TierKey | null)
      );

    const provider = getBillingProvider();
    const preview = await provider.previewProration(existingSubId, priceId, {
      endTrial,
    });

    return NextResponse.json({
      amountDue: preview.amountDue,
      currency: preview.currency,
      periodEnd: preview.periodEnd?.toISOString() ?? null,
      lineItems: preview.lineItems,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Preview proration error",
      error,
      { endpoint: "/api/billing/preview-proration", operation: "post" }
    );
    return NextResponse.json(
      { error: "Failed to preview proration" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
