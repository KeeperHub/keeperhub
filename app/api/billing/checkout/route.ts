import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { PAID_PLANS, VALID_INTERVALS } from "@/lib/billing/constants";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import type { PlanName, TierKey } from "@/lib/billing/plans";
import {
  getOrgSubscription,
  getPriceId,
  resolvePriceId,
} from "@/lib/billing/plans-server";
import type { BillingProvider } from "@/lib/billing/provider";
import { getBillingProvider } from "@/lib/billing/providers";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import {
  getTrialPeriodDays,
  isTrialEligible,
  isTrialPlan,
} from "@/lib/billing/trial";
import { db } from "@/lib/db";
import { organizationSubscriptions } from "@/lib/db/schema";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { checkBillingRateLimit } from "../_lib/rate-limit";

type CheckoutRequestBody = {
  plan?: string;
  tier?: string | null;
  interval?: string;
  // Explicit opt-in to a free trial. Only the "Start free trial" flow sets this;
  // plan cards leave it false so they pay immediately. The trial is still
  // gated by server-side eligibility on top of this intent.
  trial?: boolean;
};

async function ensureProviderCustomer(
  provider: BillingProvider,
  activeOrgId: string,
  email: string,
  userId: string,
  existingSub: Awaited<ReturnType<typeof getOrgSubscription>>
): Promise<string> {
  if (existingSub?.providerCustomerId) {
    return existingSub.providerCustomerId;
  }

  const { customerId } = await provider.createCustomer({
    email,
    organizationId: activeOrgId,
    userId,
  });

  const rows = await db
    .insert(organizationSubscriptions)
    .values({
      organizationId: activeOrgId,
      providerCustomerId: customerId,
      plan: "free",
      status: "active",
    })
    .onConflictDoUpdate({
      target: organizationSubscriptions.organizationId,
      set: {
        providerCustomerId: sql`COALESCE(${organizationSubscriptions.providerCustomerId}, ${customerId})`,
        updatedAt: new Date(),
      },
    })
    .returning({
      providerCustomerId: organizationSubscriptions.providerCustomerId,
    });

  return rows[0]?.providerCustomerId ?? customerId;
}

type ValidatedCheckout = {
  activeOrgId: string;
  email: string;
  userId: string;
  priceId: string;
  plan: PlanName;
  tier: TierKey | null;
  trial: boolean;
};

async function validateCheckoutRequest(
  request: Request
): Promise<NextResponse | ValidatedCheckout> {
  const authResult = await requireOrgOwner();
  if ("error" in authResult) {
    return authResult.error;
  }
  const { orgId: activeOrgId, email, userId } = authResult;

  const body = (await request.json()) as CheckoutRequestBody;
  const { plan, tier, interval } = body;
  const trial = body.trial === true;

  if (!(plan && PAID_PLANS.has(plan))) {
    return NextResponse.json(
      { error: "Invalid plan. Must be one of: pro, business, enterprise" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  if (!(interval && VALID_INTERVALS.has(interval))) {
    return NextResponse.json(
      { error: "Invalid interval. Must be monthly or yearly" },
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
      { error: "Price configuration not found for selected plan" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  return {
    activeOrgId,
    email,
    userId,
    priceId,
    plan: plan as PlanName,
    tier: (tier ?? null) as TierKey | null,
    trial,
  };
}

function isStripeCardError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeCardError;
}

// error_if_incomplete raises this when a plan change (e.g. ending a trial to
// upgrade) needs 3DS/SCA. Surface it as an actionable 402 rather than a 500;
// the invoice.payment_action_required webhook sets the "Complete payment" link.
function isPaymentActionRequired(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError &&
    error.code === "subscription_payment_intent_requires_action"
  );
}

async function handleExistingSubscription(
  provider: BillingProvider,
  subscriptionId: string,
  priceId: string,
  activeOrgId: string,
  currentSub: NonNullable<Awaited<ReturnType<typeof getOrgSubscription>>>,
  actor: { userId: string; request: Request },
  endTrial: boolean
): Promise<NextResponse> {
  await provider.updateSubscription(subscriptionId, priceId, { endTrial });

  const details = await provider.getSubscriptionDetails(subscriptionId);
  const resolved = details.priceId
    ? resolvePriceId(details.priceId)
    : undefined;

  await db
    .update(organizationSubscriptions)
    .set({
      providerPriceId: details.priceId ?? null,
      plan: resolved?.plan ?? currentSub.plan,
      tier: resolved?.tier ?? null,
      status: details.status ?? currentSub.status,
      currentPeriodStart: details.periodStart,
      currentPeriodEnd: details.periodEnd ?? null,
      cancelAtPeriodEnd: details.cancelAtPeriodEnd,
      updatedAt: new Date(),
    })
    .where(eq(organizationSubscriptions.organizationId, activeOrgId));

  // Intent record: which user initiated the change. The authoritative
  // subscription.plan_changed event is emitted by the Stripe webhook handler.
  await recordAuditEvent({
    actor: {
      userId: actor.userId,
      organizationId: activeOrgId,
      authMethod: "session",
    },
    action: "subscription.change_requested",
    resourceType: "subscription",
    resourceId: activeOrgId,
    before: { plan: currentSub.plan, tier: currentSub.tier },
    after: {
      plan: resolved?.plan ?? currentSub.plan,
      tier: resolved?.tier ?? null,
    },
    metadata: buildAuditMetadata(actor.request),
  });

  return NextResponse.json({ updated: true });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: HttpStatus.NOT_FOUND }
    );
  }

  try {
    const result = await validateCheckoutRequest(request);
    if (result instanceof NextResponse) {
      return result;
    }

    const { activeOrgId, email, userId, priceId, plan, tier, trial } = result;

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

    const provider = getBillingProvider();
    const sub = await getOrgSubscription(activeOrgId);
    const existingSubId = sub?.providerSubscriptionId ?? null;

    if (
      sub &&
      existingSubId &&
      sub.status !== "canceled" &&
      sub.plan !== "free"
    ) {
      if (sub.providerPriceId === priceId) {
        return NextResponse.json(
          { error: "You are already on this plan" },
          { status: HttpStatus.BAD_REQUEST }
        );
      }

      // Plan cards always charge: a trialing org that changes plan/tier from a
      // card (no `trial` intent) ends the trial and is billed now. Only the
      // Manage-trial modal sends trial:true to keep the trial, and only when the
      // target stays on the trial plan/tier (Pro 25k).
      const endTrial =
        sub.status === "trialing" && !(trial && isTrialPlan(plan, tier));

      return await handleExistingSubscription(
        provider,
        existingSubId,
        priceId,
        activeOrgId,
        sub,
        { userId, request },
        endTrial
      );
    }

    const providerCustomerId = await ensureProviderCustomer(
      provider,
      activeOrgId,
      email,
      userId,
      sub
    );

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.BETTER_AUTH_URL ??
      "http://localhost:3000";

    // A trial requires BOTH an explicit opt-in (from the "Start free trial"
    // flow) AND server-side eligibility. Plan cards omit the intent, so they
    // subscribe and pay immediately instead of being pushed into a trial.
    const trialPeriodDays =
      trial && isTrialEligible(sub, plan, tier)
        ? getTrialPeriodDays()
        : undefined;

    const { url } = await provider.createCheckoutSession({
      customerId: providerCustomerId,
      priceId,
      organizationId: activeOrgId,
      successUrl: `${appUrl}/billing?checkout=success`,
      cancelUrl: `${appUrl}/billing?checkout=canceled`,
      trialPeriodDays,
    });

    // The plan change itself is finalized by the provider webhook; this
    // records the owner-initiated intent. resolvePriceId maps the price back
    // to the human plan/tier for the trail.
    const target = resolvePriceId(priceId);
    await recordAuditEvent({
      actor: { userId, organizationId: activeOrgId, authMethod: "session" },
      action: "subscription.checkout_started",
      resourceType: "subscription",
      resourceId: activeOrgId,
      after: {
        plan: target?.plan ?? null,
        tier: target?.tier ?? null,
        trial: trialPeriodDays !== undefined,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ url });
  } catch (error) {
    if (isPaymentActionRequired(error)) {
      return NextResponse.json(
        {
          error:
            "Your bank needs to authenticate this payment. Open Manage Billing to complete it.",
        },
        { status: HttpStatus.PAYMENT_REQUIRED }
      );
    }

    if (isStripeCardError(error)) {
      return NextResponse.json(
        { error: "Payment failed. Please update your payment method." },
        { status: HttpStatus.PAYMENT_REQUIRED }
      );
    }

    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Checkout error",
      error,
      { endpoint: "/api/billing/checkout", operation: "post" }
    );
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
