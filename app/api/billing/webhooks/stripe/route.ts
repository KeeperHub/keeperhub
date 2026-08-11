import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { handleBillingEvent } from "@/lib/billing/handle-billing-event";
import type { BillingWebhookEvent } from "@/lib/billing/provider";
import { getBillingProvider } from "@/lib/billing/providers";
import { UnknownEventTypeError } from "@/lib/billing/providers/stripe";
import { db } from "@/lib/db";
import { billingEvents } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

async function claimEvent(
  providerEventId: string,
  type: string,
  data: unknown
): Promise<boolean> {
  const inserted = await db
    .insert(billingEvents)
    .values({
      providerEventId,
      type,
      data,
      processed: false,
    })
    .onConflictDoNothing({ target: billingEvents.providerEventId })
    .returning({ id: billingEvents.id });
  return inserted.length > 0;
}

async function markProcessed(providerEventId: string): Promise<void> {
  await db
    .update(billingEvents)
    .set({ processed: true })
    .where(eq(billingEvents.providerEventId, providerEventId));
}

async function releaseClaim(providerEventId: string): Promise<void> {
  await db
    .delete(billingEvents)
    .where(eq(billingEvents.providerEventId, providerEventId));
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = await request.text();

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 }
      );
    }

    const provider = getBillingProvider();
    let event: BillingWebhookEvent;
    try {
      event = await provider.verifyWebhook(body, signature);
    } catch (error) {
      if (error instanceof UnknownEventTypeError) {
        return NextResponse.json({ received: true });
      }
      if (
        error instanceof Error &&
        error.message === "STRIPE_WEBHOOK_SECRET not configured"
      ) {
        return NextResponse.json(
          { error: "Webhook not configured" },
          { status: 500 }
        );
      }
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    const claimed = await claimEvent(
      event.providerEventId,
      event.type,
      event.data
    );
    if (!claimed) {
      return NextResponse.json({ received: true });
    }

    try {
      await handleBillingEvent(event, provider);
      await markProcessed(event.providerEventId);
    } catch (handlerError) {
      // Release the claim so Stripe retries can re-process this event
      await releaseClaim(event.providerEventId);
      throw handlerError;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing Webhook] Handler failed",
      error,
      { endpoint: "/api/billing/webhooks/stripe", operation: "post" }
    );
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
