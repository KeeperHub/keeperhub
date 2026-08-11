import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import type {
  BillingDetails,
  BillingProvider,
  BillingWebhookEvent,
  CollectInvoiceResult,
  CreateCheckoutParams,
  CreateCustomerParams,
  CreateInvoiceItemParams,
  CreateInvoiceItemResult,
  InvoiceItem,
  ListInvoicesParams,
  ListInvoicesResult,
  ProrationPreview,
  SubscriptionDetails,
} from "../provider";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function getStripe(): Stripe {
  if (!stripe) {
    throw new Error(
      "Stripe SDK not initialized. Set STRIPE_SECRET_KEY to enable billing."
    );
  }
  return stripe;
}

function isStripeNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode: number }).statusCode === 404
  );
}

const EVENT_TYPE_MAP: Record<string, BillingWebhookEvent["type"] | undefined> =
  {
    "checkout.session.completed": "checkout.completed",
    "customer.subscription.updated": "subscription.updated",
    "customer.subscription.deleted": "subscription.deleted",
    "invoice.created": "invoice.created",
    "invoice.paid": "invoice.paid",
    "invoice.payment_failed": "invoice.payment_failed",
    "invoice.overdue": "invoice.overdue",
    "invoice.payment_action_required": "invoice.payment_action_required",
  };

function pickMetadata(
  metadata: Stripe.Metadata | null | undefined
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }
  const entries = Object.entries(metadata).filter(
    ([, v]) => typeof v === "string" && v.length > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getSubscriptionPeriod(subscription: Stripe.Subscription): {
  start: Date;
  end: Date | null;
} {
  const currentPeriodStart = subscription.items.data[0]?.current_period_start;
  const start = currentPeriodStart
    ? new Date(currentPeriodStart * 1000)
    : new Date(subscription.start_date * 1000);
  const currentPeriodEnd = subscription.items.data[0]?.current_period_end;
  const end = currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null;
  return { start, end };
}

function getSubscriptionIdFromInvoice(
  invoice: Stripe.Invoice
): string | undefined {
  const parent = invoice.parent;
  if (
    parent !== null &&
    parent !== undefined &&
    "subscription_details" in parent &&
    parent.subscription_details !== null &&
    parent.subscription_details !== undefined
  ) {
    const details = parent.subscription_details as {
      subscription?: string;
    };
    return details.subscription ?? undefined;
  }
  return undefined;
}

function normalizeCheckoutEvent(
  event: Stripe.Event,
  session: Stripe.Checkout.Session
): BillingWebhookEvent {
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  return {
    type: "checkout.completed",
    providerEventId: event.id,
    data: {
      organizationId: session.metadata?.organizationId ?? undefined,
      providerSubscriptionId: subscriptionId ?? undefined,
    },
  };
}

function normalizeSubscriptionEvent(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  type: "subscription.updated" | "subscription.deleted"
): BillingWebhookEvent {
  const item = subscription.items.data[0];
  const priceId = item?.price.id;
  const period = getSubscriptionPeriod(subscription);

  const cancelAtPeriodEnd =
    subscription.cancel_at_period_end || subscription.cancel_at !== null;

  return {
    type,
    providerEventId: event.id,
    data: {
      providerSubscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd,
      periodStart: period.start,
      periodEnd: period.end,
      priceId,
      subscriptionMetadata: pickMetadata(subscription.metadata),
      priceMetadata: pickMetadata(item?.price.metadata),
    },
  };
}

function normalizeInvoiceEvent(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  type: BillingWebhookEvent["type"]
): BillingWebhookEvent {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;

  return {
    type,
    providerEventId: event.id,
    data: {
      providerSubscriptionId: getSubscriptionIdFromInvoice(invoice),
      providerCustomerId: customerId ?? undefined,
      invoiceId: invoice.id ?? undefined,
      invoiceUrl: invoice.hosted_invoice_url ?? undefined,
      billingReason: invoice.billing_reason ?? undefined,
    },
  };
}

// Strip Stripe's verbose line item formatting:
// "1 × Plan Name (at $49.00 / month)" → "Plan Name"
const QUANTITY_PREFIX_RE = /^\d+\s*[x×]\s*/i;
const PRICE_SUFFIX_RE = /\s*\(at\s+\$[\d,.]+\s*\/\s*\w+\)\s*$/;

function isProrationLine(line: Stripe.InvoiceLineItem): boolean {
  return (
    line.parent?.subscription_item_details?.proration ??
    line.parent?.invoice_item_details?.proration ??
    false
  );
}

function summarizeInvoiceLines(lines: Stripe.InvoiceLineItem[]): string {
  if (lines.length === 0) {
    return "Subscription";
  }

  const hasProration = lines.some(isProrationLine);

  const planLine =
    lines.find((line) => !isProrationLine(line) && line.amount > 0) ??
    lines.at(-1);

  const rawDesc = planLine?.description ?? "Subscription";
  const cleaned = rawDesc
    .replace(QUANTITY_PREFIX_RE, "")
    .replace(PRICE_SUFFIX_RE, "")
    .trim();

  if (hasProration) {
    return `Plan change: ${cleaned}`;
  }

  return cleaned;
}

function mapStripeInvoice(inv: Stripe.Invoice): InvoiceItem {
  const description = summarizeInvoiceLines(inv.lines.data);

  const createdMs = inv.created * 1000;
  let periodStartMs = createdMs;
  let periodEndMs = createdMs;
  for (const line of inv.lines.data) {
    if (line.period.start) {
      const startMs = line.period.start * 1000;
      if (startMs < periodStartMs) {
        periodStartMs = startMs;
      }
    }
    if (line.period.end) {
      const endMs = line.period.end * 1000;
      if (endMs > periodEndMs) {
        periodEndMs = endMs;
      }
    }
  }

  return {
    id: inv.id,
    date: new Date(createdMs),
    amount: inv.amount_paid,
    currency: inv.currency,
    status: (inv.status ?? "draft") as InvoiceItem["status"],
    description,
    periodStart: new Date(periodStartMs),
    periodEnd: new Date(periodEndMs),
    invoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
  };
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe";

  async createCustomer(
    params: CreateCustomerParams
  ): Promise<{ customerId: string }> {
    const customer = await getStripe().customers.create({
      email: params.email,
      metadata: {
        organizationId: params.organizationId,
        userId: params.userId,
      },
    });
    return { customerId: customer.id };
  }

  async createCheckoutSession(
    params: CreateCheckoutParams
  ): Promise<{ url: string }> {
    const session = await getStripe().checkout.sessions.create({
      customer: params.customerId,
      mode: "subscription",
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      // Let customers redeem promotion codes created in the Stripe dashboard.
      allow_promotion_codes: true,
      // Always collect a card up front (do not rely on the Stripe default), so a
      // trial has a payment method on file and auto-charges when it ends.
      payment_method_collection: "always",
      metadata: {
        organizationId: params.organizationId,
      },
      ...(params.trialPeriodDays !== undefined && {
        subscription_data: { trial_period_days: params.trialPeriodDays },
      }),
    });

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }

    return { url: session.url };
  }

  async createPortalSession(
    customerId: string,
    returnUrl: string
  ): Promise<{ url: string }> {
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  async getBillingDetails(customerId: string): Promise<BillingDetails> {
    const s = getStripe();
    const customer = await s.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });

    if (customer.deleted) {
      return { paymentMethod: null, billingEmail: null };
    }

    const defaultPaymentMethod =
      customer.invoice_settings?.default_payment_method;
    let card: Stripe.PaymentMethod.Card | null =
      defaultPaymentMethod &&
      typeof defaultPaymentMethod === "object" &&
      defaultPaymentMethod.type === "card"
        ? (defaultPaymentMethod.card ?? null)
        : null;

    // Stripe Checkout stores the default payment method on the subscription,
    // not on the customer. Prefer the active subscription's default PM, since
    // that's the card actually being charged. Fall back to any status only if
    // there is no active sub, to preserve data for past_due / canceled users
    // viewing billing history.
    if (!card) {
      let subs = await s.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
        expand: ["data.default_payment_method"],
      });
      if (subs.data.length === 0) {
        subs = await s.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 1,
          expand: ["data.default_payment_method"],
        });
      }
      const subDefault = subs.data[0]?.default_payment_method;
      if (
        subDefault &&
        typeof subDefault === "object" &&
        subDefault.type === "card"
      ) {
        card = subDefault.card ?? null;
      }
    }

    if (!card) {
      const methods = await s.paymentMethods.list({
        customer: customerId,
        type: "card",
        limit: 1,
      });
      card = methods.data[0]?.card ?? null;
    }

    return {
      paymentMethod: card
        ? {
            brand: card.brand,
            last4: card.last4,
            expMonth: card.exp_month,
            expYear: card.exp_year,
          }
        : null,
      billingEmail: customer.email ?? null,
    };
  }

  // biome-ignore lint/suspicious/useAwait: must be async to satisfy BillingProvider interface contract
  async verifyWebhook(
    body: string,
    signature: string
  ): Promise<BillingWebhookEvent> {
    if (!WEBHOOK_SECRET) {
      throw new Error("STRIPE_WEBHOOK_SECRET not configured");
    }

    const event = getStripe().webhooks.constructEvent(
      body,
      signature,
      WEBHOOK_SECRET
    );

    const normalizedType = EVENT_TYPE_MAP[event.type];
    if (!normalizedType) {
      throw new UnknownEventTypeError(event.type, event.id);
    }

    switch (event.type) {
      case "checkout.session.completed":
        return normalizeCheckoutEvent(event, event.data.object);

      case "customer.subscription.updated":
        return normalizeSubscriptionEvent(
          event,
          event.data.object,
          "subscription.updated"
        );

      case "customer.subscription.deleted":
        return normalizeSubscriptionEvent(
          event,
          event.data.object,
          "subscription.deleted"
        );

      case "invoice.created":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.overdue":
      case "invoice.payment_action_required":
        return normalizeInvoiceEvent(event, event.data.object, normalizedType);

      default:
        throw new UnknownEventTypeError(event.type, event.id);
    }
  }

  async listInvoices(params: ListInvoicesParams): Promise<ListInvoicesResult> {
    const listParams: Stripe.InvoiceListParams = {
      customer: params.customerId,
      limit: params.limit,
      status: "paid",
    };

    if (params.startingAfter) {
      listParams.starting_after = params.startingAfter;
    }

    const list = await getStripe().invoices.list(listParams);

    const invoices: InvoiceItem[] = list.data.map(mapStripeInvoice);

    return { invoices, hasMore: list.has_more };
  }

  async updateSubscription(
    subscriptionId: string,
    newPriceId: string,
    options?: { endTrial?: boolean }
  ): Promise<{ subscriptionId: string }> {
    const s = getStripe();
    const subscription = await s.subscriptions.retrieve(subscriptionId);
    const currentItemId = subscription.items.data[0]?.id;

    if (!currentItemId) {
      throw new Error("No subscription item found to update");
    }

    const currentInterval =
      subscription.items.data[0]?.price.recurring?.interval;
    const newPrice = await s.prices.retrieve(newPriceId);
    const intervalChanging = currentInterval !== newPrice.recurring?.interval;

    const updated = await s.subscriptions.update(subscriptionId, {
      items: [{ id: currentItemId, price: newPriceId }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      cancel_at_period_end: false,
      ...(intervalChanging && { billing_cycle_anchor: "now" as const }),
      // Switching a trialing sub to a non-trial plan ends the trial now so the
      // new plan is charged immediately instead of inheriting the free trial.
      ...(options?.endTrial && { trial_end: "now" as const }),
    });

    return { subscriptionId: updated.id };
  }

  async cancelSubscription(
    subscriptionId: string
  ): Promise<{ cancelAtPeriodEnd: boolean; periodEnd: Date | null }> {
    const updated = await getStripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
    const currentPeriodEnd = updated.items.data[0]?.current_period_end;
    const periodEnd = currentPeriodEnd
      ? new Date(currentPeriodEnd * 1000)
      : null;
    return {
      cancelAtPeriodEnd: updated.cancel_at_period_end,
      periodEnd,
    };
  }

  async getSubscriptionDetails(
    subscriptionId: string
  ): Promise<SubscriptionDetails> {
    const subscription =
      await getStripe().subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data[0];
    const priceId = item?.price.id;
    const period = getSubscriptionPeriod(subscription);

    return {
      priceId,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      periodStart: period.start,
      periodEnd: period.end,
      subscriptionMetadata: pickMetadata(subscription.metadata),
      priceMetadata: pickMetadata(item?.price.metadata),
    };
  }

  async previewProration(
    subscriptionId: string,
    newPriceId: string,
    options?: { endTrial?: boolean }
  ): Promise<ProrationPreview> {
    const s = getStripe();
    const subscription = await s.subscriptions.retrieve(subscriptionId);
    const currentItemId = subscription.items.data[0]?.id;

    if (!currentItemId) {
      throw new Error("No subscription item found to preview");
    }

    const currentInterval =
      subscription.items.data[0]?.price.recurring?.interval;
    const newPrice = await s.prices.retrieve(newPriceId);
    const intervalChanging = currentInterval !== newPrice.recurring?.interval;

    const preview = await s.invoices.createPreview({
      subscription: subscriptionId,
      subscription_details: {
        items: [{ id: currentItemId, price: newPriceId }],
        proration_behavior: "always_invoice",
        // When intervals differ, billing_cycle_anchor resets to "now" during
        // the actual update, so omit proration_date to let Stripe calculate
        // from the anchor reset. For same-interval changes, pin to now.
        ...(!intervalChanging && {
          proration_date: Math.floor(Date.now() / 1000),
        }),
        // Mirror the real update: ending the trial makes the preview show the
        // full charge for the new plan instead of $0.
        ...(options?.endTrial && { trial_end: "now" as const }),
      },
    });

    const period = preview.period_end
      ? new Date(preview.period_end * 1000)
      : null;

    const lineItems: ProrationPreview["lineItems"] = [];
    for (const line of preview.lines.data) {
      const isProration =
        line.parent?.subscription_item_details?.proration ??
        line.parent?.invoice_item_details?.proration ??
        false;
      lineItems.push({
        description: line.description ?? "",
        amount: line.amount,
        proration: isProration,
      });
    }

    const subtotal = preview.subtotal ?? 0;
    const total = preview.total ?? subtotal;
    const amountDue = preview.amount_due ?? 0;
    const appliedBalance = amountDue - total;

    return {
      amountDue,
      subtotal,
      appliedBalance,
      currency: preview.currency,
      periodEnd: period,
      lineItems,
    };
  }

  async createInvoiceItem(
    params: CreateInvoiceItemParams
  ): Promise<CreateInvoiceItemResult> {
    const body = {
      customer: params.customerId,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      metadata: params.metadata,
      ...(params.invoiceId && { invoice: params.invoiceId }),
    };

    // Callers without a key keep the original single-argument call.
    const item = params.idempotencyKey
      ? await getStripe().invoiceItems.create(body, {
          idempotencyKey: params.idempotencyKey,
        })
      : await getStripe().invoiceItems.create(body);

    return { invoiceItemId: item.id };
  }

  async getInvoiceStatus(
    invoiceId: string
  ): Promise<{ status: string; paid: boolean }> {
    const invoice = await getStripe().invoices.retrieve(invoiceId);
    return {
      status: invoice.status ?? "draft",
      paid: invoice.status === "paid",
    };
  }

  async getInvoiceForItem(
    invoiceItemId: string
  ): Promise<{ invoiceId: string; status: string; paid: boolean } | undefined> {
    let item: Stripe.InvoiceItem;
    try {
      item = await getStripe().invoiceItems.retrieve(invoiceItemId);
    } catch (error: unknown) {
      // Invoice items are deleted by Stripe once consumed into a finalized
      // invoice, so a 404 is expected for older items.
      if (isStripeNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    const invoiceId =
      typeof item.invoice === "string" ? item.invoice : item.invoice?.id;

    if (!invoiceId) {
      return undefined;
    }

    const invoice = await getStripe().invoices.retrieve(invoiceId);
    return {
      invoiceId,
      status: invoice.status ?? "draft",
      paid: invoice.status === "paid",
    };
  }

  async createDraftInvoice(
    customerId: string,
    currency: string
  ): Promise<{ invoiceId: string }> {
    // No `subscription`, so Stripe adds no plan or proration lines, and
    // pending_invoice_items_behavior "exclude" keeps unrelated pending items
    // off it. The invoice bills exactly what is attached to it afterwards.
    const invoice = await getStripe().invoices.create({
      customer: customerId,
      currency,
      auto_advance: false,
      collection_method: "charge_automatically",
      pending_invoice_items_behavior: "exclude",
    });

    if (!invoice.id) {
      throw new Error("Stripe did not return an invoice ID");
    }

    return { invoiceId: invoice.id };
  }

  async finalizeAndCollectInvoice(
    invoiceId: string
  ): Promise<CollectInvoiceResult> {
    const s = getStripe();
    const existing = await s.invoices.retrieve(invoiceId);

    if (existing.status === "paid") {
      return { invoiceId, paid: true };
    }

    // Only a draft needs finalizing. A retry on an already-open invoice, e.g.
    // when a returning org settles what it left behind, goes straight to pay.
    if (existing.status === "draft") {
      const finalized = await s.invoices.finalizeInvoice(invoiceId);
      if (finalized.status === "paid") {
        return { invoiceId, paid: true };
      }
    }

    try {
      const paid = await s.invoices.pay(invoiceId);
      return paid.status === "paid"
        ? { invoiceId, paid: true }
        : {
            invoiceId,
            paid: false,
            failureReason: `invoice status ${paid.status ?? "unknown"}`,
          };
    } catch (error: unknown) {
      // A decline or a missing payment method is an expected outcome here, not
      // a fault: the invoice stays open and the amount is carried as debt.
      return {
        invoiceId,
        paid: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // A 400 means the request was evaluated and refused, so no object was
  // created. Transport and rate-limit failures say nothing about whether the
  // provider acted, so they are deliberately excluded.
  wasRejectedWithoutCreating(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      (error as { type: unknown }).type === "StripeInvalidRequestError"
    );
  }

  async deleteDraftInvoice(invoiceId: string): Promise<void> {
    try {
      await getStripe().invoices.del(invoiceId);
    } catch (error: unknown) {
      // Already gone or already finalized; nothing left to discard.
      if (isStripeNotFound(error)) {
        return;
      }
      throw error;
    }
  }
}

export class UnknownEventTypeError extends Error {
  readonly eventType: string;
  readonly eventId: string;

  constructor(eventType: string, eventId: string) {
    super(`Unhandled webhook event type: ${eventType}`);
    this.name = "UnknownEventTypeError";
    this.eventType = eventType;
    this.eventId = eventId;
  }
}
