import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationSubscriptions,
  overageBillingRecords,
} from "@/lib/db/schema";
import {
  ErrorCategory,
  logSystemWarn,
  logUserError,
  logWarn,
} from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { recordAuditEvent } from "@/lib/security/audit-log";
import { BILLING_ALERTS } from "./constants";
import { clearDebtForInvoice } from "./execution-debt";
import {
  billOverageForOrg,
  collectFinalPeriodOverage,
  collectOutstandingOverage,
} from "./overage";
import { type PlanName, parsePlanName } from "./plans";
import { resolveSubscriptionPlan } from "./plans-server";
import type { BillingProvider, BillingWebhookEvent } from "./provider";

const LOG_PREFIX = "[Billing Handler]";

// A row still holding the closing period reads as already-ended at the moment
// the renewal invoice is created, so only clock skew can misread it. The other
// candidate period ends a full cycle away, well outside this allowance.
const PERIOD_ROLL_SKEW_MS = 10 * 60 * 1000;

// Numeric ranking used to label plan changes as upgrade/downgrade. Same-plan
// tier changes (e.g. Pro 25k -> Pro 50k) are labeled "tier_change" since the
// dashboard tracks them separately from plan-level moves.
const PLAN_RANK: Record<PlanName, number> = {
  free: 0,
  pro: 1,
  business: 2,
  enterprise: 3,
};

function planChangeDirection(
  from: PlanName,
  to: PlanName
): "upgrade" | "downgrade" | "tier_change" {
  if (from === to) {
    return "tier_change";
  }
  return PLAN_RANK[to] > PLAN_RANK[from] ? "upgrade" : "downgrade";
}

type SubscriptionRow = typeof organizationSubscriptions.$inferSelect;

async function findSubscriptionByProviderId(
  providerSubscriptionId: string
): Promise<SubscriptionRow | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    )
    .limit(1);
  return rows[0];
}

async function findSubscriptionByCustomerId(
  providerCustomerId: string
): Promise<SubscriptionRow | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.providerCustomerId, providerCustomerId))
    .limit(1);
  return rows[0];
}

export async function handleBillingEvent(
  event: BillingWebhookEvent,
  provider: BillingProvider
): Promise<void> {
  const { type, data } = event;
  console.info(LOG_PREFIX, "Handling event:", type);

  switch (type) {
    case "checkout.completed": {
      await handleCheckoutCompleted(data, provider);
      break;
    }
    case "subscription.updated": {
      await handleSubscriptionUpdated(data);
      break;
    }
    case "subscription.deleted": {
      await handleSubscriptionDeleted(data);
      break;
    }
    case "invoice.created": {
      await handleInvoiceCreated(data);
      break;
    }
    case "invoice.paid": {
      await handleInvoicePaid(data, provider);
      break;
    }
    case "invoice.payment_failed": {
      await handleInvoicePaymentFailed(data);
      break;
    }
    case "invoice.overdue": {
      await handleInvoiceOverdue(data);
      break;
    }
    case "invoice.payment_action_required": {
      await handleInvoicePaymentActionRequired(data);
      break;
    }
    default:
      break;
  }
}

async function handleCheckoutCompleted(
  data: BillingWebhookEvent["data"],
  provider: BillingProvider
): Promise<void> {
  const { organizationId, providerSubscriptionId } = data;

  if (!organizationId) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing Webhook] No organizationId in checkout event"
    );
    return;
  }

  if (!providerSubscriptionId) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing Webhook] No subscription in checkout event"
    );
    return;
  }

  console.info(
    LOG_PREFIX,
    "checkout.completed - orgId:",
    organizationId,
    "subId:",
    providerSubscriptionId
  );

  const details = await provider.getSubscriptionDetails(providerSubscriptionId);
  console.info(
    LOG_PREFIX,
    "Subscription details - priceId:",
    details.priceId,
    "status:",
    details.status
  );

  if (!details.priceId) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `${LOG_PREFIX} No price ID found in subscription`
    );
    return;
  }

  const resolved = resolveSubscriptionPlan(details.priceId, {
    subscription: details.subscriptionMetadata,
    price: details.priceMetadata,
  });
  if (!resolved) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `${LOG_PREFIX} Unknown priceId, cannot resolve plan`,
      undefined,
      { price_id: details.priceId }
    );
    return;
  }
  const { plan, tier } = resolved;
  console.info(
    LOG_PREFIX,
    "Resolved plan:",
    plan,
    "tier:",
    tier,
    "from priceId:",
    details.priceId
  );

  // checkout.completed only fires on success, so the subscription is either
  // trialing (trial requested) or active. Persist the real status and stamp
  // trial consumption so the org cannot start a second trial.
  const isTrialing = details.status === "trialing";

  const subscriptionData = {
    providerSubscriptionId,
    providerPriceId: details.priceId,
    plan,
    tier,
    status: isTrialing ? ("trialing" as const) : ("active" as const),
    currentPeriodStart: details.periodStart,
    currentPeriodEnd: details.periodEnd,
    cancelAtPeriodEnd: details.cancelAtPeriodEnd,
    updatedAt: new Date(),
    ...(isTrialing && { trialStartedAt: new Date() }),
  };

  await db
    .insert(organizationSubscriptions)
    .values({
      organizationId,
      ...subscriptionData,
    })
    .onConflictDoUpdate({
      target: organizationSubscriptions.organizationId,
      set: subscriptionData,
    });

  console.info(LOG_PREFIX, "Upserted subscription for org:", organizationId);

  // A returning org may have left an unpaid overage invoice behind when it
  // cancelled. Subscribing again means there is a payment method on file, so
  // this is the moment to settle it. Never blocks the subscription itself.
  try {
    await collectOutstandingOverage(organizationId, provider);
  } catch (error) {
    logSystemWarn(
      ErrorCategory.BILLING,
      `${LOG_PREFIX} Failed to settle outstanding overage on resubscribe`,
      error,
      { org_id: organizationId }
    );
  }

  const metrics = getMetricsCollector();
  metrics.incrementCounter(MetricNames.BILLING_SUBSCRIPTION_CREATED, {
    plan,
    tier: tier ?? "none",
  });
  if (isTrialing) {
    metrics.incrementCounter(MetricNames.BILLING_TRIAL_STARTED, {
      plan,
      tier: tier ?? "none",
    });
  }
}

// Build the DB update payload for a subscription.updated event.
// Only changes plan/tier if the priceId actually changed (upgrade or plan switch).
// When cancelAtPeriodEnd is set, Stripe sends the same priceId -- we keep the
// current plan active until the period ends (handled by subscription.deleted).
function buildSubscriptionUpdate(
  data: BillingWebhookEvent["data"],
  current: SubscriptionRow
): Record<string, unknown> {
  const {
    priceId,
    status,
    cancelAtPeriodEnd,
    periodStart,
    periodEnd,
    subscriptionMetadata,
    priceMetadata,
  } = data;

  const priceChanged =
    priceId !== undefined && priceId !== current.providerPriceId;
  const resolved =
    priceChanged && priceId
      ? resolveSubscriptionPlan(priceId, {
          subscription: subscriptionMetadata,
          price: priceMetadata,
        })
      : undefined;

  console.info(
    LOG_PREFIX,
    "subscription.updated - subId:",
    current.providerSubscriptionId,
    "status:",
    status,
    "cancelAtPeriodEnd:",
    cancelAtPeriodEnd,
    "priceChanged:",
    priceChanged,
    priceChanged ? `${current.providerPriceId} -> ${priceId}` : "(no change)",
    "resolved:",
    resolved?.plan ?? current.plan,
    resolved?.tier ?? current.tier
  );

  const update: Record<string, unknown> = {
    status: status ?? current.status,
    currentPeriodStart: periodStart ?? current.currentPeriodStart,
    currentPeriodEnd: periodEnd ?? current.currentPeriodEnd,
    cancelAtPeriodEnd: cancelAtPeriodEnd ?? current.cancelAtPeriodEnd,
    updatedAt: new Date(),
  };

  if (priceChanged) {
    update.providerPriceId = priceId ?? null;
    update.plan = resolved?.plan ?? current.plan;
    update.tier = resolved?.tier ?? null;
  }

  return update;
}

/**
 * Put the closing period's overage on the renewal invoice that closes it.
 *
 * The provider emits this while the renewal invoice is still a draft, which is
 * the only window in which an invoice item can be added to it. Billing from
 * subscription.updated instead is always too late: that event fires once the
 * invoice already exists, so the item is left pending and lands on the next
 * cycle's invoice a month later.
 */
async function handleInvoiceCreated(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceId, billingReason } = data;

  // Only a cycle renewal closes a period; one-off and proration invoices do not.
  if (
    !(providerSubscriptionId && invoiceId) ||
    billingReason !== "subscription_cycle"
  ) {
    return;
  }

  const current = await findSubscriptionByProviderId(providerSubscriptionId);
  if (
    !(
      current?.currentPeriodStart instanceof Date &&
      current.currentPeriodEnd instanceof Date
    )
  ) {
    return;
  }

  // The row holds the closing period only until subscription.updated advances
  // it. If that event won the race it already billed this period, so there is
  // nothing left to attach.
  if (current.currentPeriodEnd.getTime() > Date.now() + PERIOD_ROLL_SKEW_MS) {
    logWarn(
      `${LOG_PREFIX} invoice.created arrived after the period advanced; overage stays on the following invoice`,
      { org_id: current.organizationId }
    );
    return;
  }

  try {
    await billOverageForOrg(
      current.organizationId,
      current.currentPeriodStart,
      current.currentPeriodEnd,
      { invoiceId }
    );
  } catch (error) {
    logSystemWarn(
      ErrorCategory.BILLING,
      `${LOG_PREFIX} Failed to bill overage onto the closing invoice (will be retried by scan)`,
      error,
      { org_id: current.organizationId }
    );
  }
}

async function handleSubscriptionUpdated(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId } = data;

  if (!providerSubscriptionId) {
    return;
  }

  const current = await findSubscriptionByProviderId(providerSubscriptionId);
  if (!current) {
    logWarn(
      `${LOG_PREFIX} subscription.updated - no matching row for subId: ${providerSubscriptionId}`
    );
    return;
  }

  const update = buildSubscriptionUpdate(data, current);

  // Bill overage BEFORE updating the subscription row so that if billing fails,
  // the old period data remains on the row for the scan endpoint to pick up.
  const periodRolled =
    data.periodStart instanceof Date &&
    current.currentPeriodStart instanceof Date &&
    data.periodStart.getTime() !== current.currentPeriodStart.getTime();

  if (
    periodRolled &&
    current.currentPeriodStart instanceof Date &&
    current.currentPeriodEnd instanceof Date
  ) {
    try {
      await billOverageForOrg(
        current.organizationId,
        current.currentPeriodStart,
        current.currentPeriodEnd
      );
    } catch (error: unknown) {
      logSystemWarn(
        ErrorCategory.BILLING,
        `${LOG_PREFIX} Failed to bill overage for org (will be retried by scan)`,
        error,
        { org_id: current.organizationId }
      );
    }
  }

  await db
    .update(organizationSubscriptions)
    .set(update)
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );

  const metrics = getMetricsCollector();
  const newPlanRaw = update.plan;
  const newPlan: PlanName =
    typeof newPlanRaw === "string"
      ? parsePlanName(newPlanRaw, parsePlanName(current.plan))
      : parsePlanName(current.plan);
  metrics.incrementCounter(MetricNames.BILLING_SUBSCRIPTION_UPDATED, {
    plan: newPlan,
  });

  // Trial conversion: a trialing subscription became active (card charged at
  // trial end). This is the funnel counterpart to billing.trial.started.
  if (current.status === "trialing" && data.status === "active") {
    metrics.incrementCounter(MetricNames.BILLING_TRIAL_CONVERTED, {
      plan: newPlan,
      tier: (update.tier as string | null) ?? current.tier ?? "none",
    });
  }

  // Plan change is signaled by priceChanged in buildSubscriptionUpdate
  // (only present in the update payload when the price differs).
  if (update.providerPriceId !== undefined) {
    const fromPlan = parsePlanName(current.plan);
    metrics.incrementCounter(MetricNames.BILLING_SUBSCRIPTION_PLAN_CHANGED, {
      from_plan: fromPlan,
      to_plan: newPlan,
      direction: planChangeDirection(fromPlan, newPlan),
    });

    // Authoritative plan-change record. The acting user is captured separately
    // by subscription.change_requested on the checkout route; here the actor
    // is the provider webhook that finalized the transition.
    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: current.organizationId,
        authMethod: "internal",
      },
      action: "subscription.plan_changed",
      resourceType: "subscription",
      resourceId: current.organizationId,
      before: { plan: current.plan, tier: current.tier },
      after: { plan: newPlan, tier: (update.tier as string | null) ?? null },
      metadata: { source: "stripe", providerSubscriptionId },
    });
  }
}

/**
 * Charge the closing period's overage on a subscription that is ending.
 *
 * Never throws. The downgrade has to complete regardless: leaving an org on a
 * paid plan because a card was declined would hand it a plan it is not paying
 * for. An uncollected amount stays on the open invoice and is picked up by the
 * debt scan.
 */
async function collectFinalPeriodOverageSafely(
  current: SubscriptionRow | undefined
): Promise<void> {
  if (
    !(
      current?.providerCustomerId &&
      current.currentPeriodStart instanceof Date &&
      current.currentPeriodEnd instanceof Date
    )
  ) {
    return;
  }

  try {
    await collectFinalPeriodOverage(
      current.organizationId,
      current.currentPeriodStart,
      current.currentPeriodEnd,
      current.providerCustomerId
    );
  } catch (error) {
    logSystemWarn(
      ErrorCategory.BILLING,
      `${LOG_PREFIX} Failed to bill the final period on cancellation (will be retried by scan)`,
      error,
      { org_id: current.organizationId }
    );
  }
}

async function handleSubscriptionDeleted(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId } = data;

  if (!providerSubscriptionId) {
    return;
  }

  const current = await findSubscriptionByProviderId(providerSubscriptionId);
  const periodEnd =
    data.periodEnd instanceof Date ? data.periodEnd : current?.currentPeriodEnd;
  const now = new Date();

  // If the billing period hasn't ended yet (cancel at period end),
  // keep the plan active but mark status as canceled so the UI shows
  // the cancellation notice. The plan features remain available.
  if (periodEnd !== null && periodEnd !== undefined && periodEnd > now) {
    console.info(
      LOG_PREFIX,
      "subscription.deleted - subId:",
      providerSubscriptionId,
      "period still active until:",
      periodEnd.toISOString(),
      "- keeping plan, marking canceled"
    );

    await db
      .update(organizationSubscriptions)
      .set({
        status: "canceled",
        cancelAtPeriodEnd: false,
        updatedAt: now,
      })
      .where(
        eq(
          organizationSubscriptions.providerSubscriptionId,
          providerSubscriptionId
        )
      );

    // Debt is deliberately left in place. The org still owes the amount, and
    // it is what gates them if they subscribe again. The period is not over
    // here, so the excess is billed later by the overage scan.

    getMetricsCollector().incrementCounter(
      MetricNames.BILLING_SUBSCRIPTION_CANCELED,
      {
        plan: parsePlanName(current?.plan, "free"),
        tier: current?.tier ?? "none",
      }
    );

    if (current) {
      await recordAuditEvent({
        actor: {
          userId: null,
          organizationId: current.organizationId,
          authMethod: "internal",
        },
        action: "subscription.canceled",
        resourceType: "subscription",
        resourceId: current.organizationId,
        before: { plan: current.plan, status: current.status },
        after: { status: "canceled", activeUntil: periodEnd.toISOString() },
        metadata: { source: "stripe", providerSubscriptionId },
      });
    }
    return;
  }

  // Period has ended (or no period data) -- fully reset to free
  console.info(
    LOG_PREFIX,
    "subscription.deleted - subId:",
    providerSubscriptionId,
    "period ended, resetting to free"
  );

  // Before the reset, while the row still carries the paid plan and its limit.
  // billOverageForOrg reads plan off the row and skips a free one, so this
  // cannot move below the update.
  await collectFinalPeriodOverageSafely(current);

  await db
    .update(organizationSubscriptions)
    .set({
      plan: "free",
      tier: null,
      status: "canceled",
      providerSubscriptionId: null,
      providerPriceId: null,
      cancelAtPeriodEnd: false,
      updatedAt: now,
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );

  // Debt survives the downgrade. Dropping to free does not settle what the org
  // already ran up, and the record is what lets us collect if they return.

  getMetricsCollector().incrementCounter(
    MetricNames.BILLING_SUBSCRIPTION_CANCELED,
    {
      plan: parsePlanName(current?.plan, "free"),
      tier: current?.tier ?? "none",
    }
  );

  if (current) {
    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: current.organizationId,
        authMethod: "internal",
      },
      action: "subscription.canceled",
      resourceType: "subscription",
      resourceId: current.organizationId,
      before: { plan: current.plan, status: current.status },
      after: { plan: "free", status: "canceled" },
      metadata: { source: "stripe", providerSubscriptionId },
    });
  }
}

async function markOverageRecordsPaid(
  organizationId: string,
  invoiceId: string,
  provider: BillingProvider
): Promise<void> {
  // F-023 / KEEP-748: attribute an overage record to this invoice ONLY when the
  // record's own invoice item actually belongs to it. The previous behavior
  // stamped EVERY billed, unattributed record for the org with whatever invoice
  // happened to be paid -- so an unrelated standalone/manual invoice could
  // claim all pending overage, and the subsequent scanAndCreateDebt early-return
  // (providerInvoiceId set + paid) silently waived it. Resolve each record's
  // invoice via the same getInvoiceForItem path scanAndCreateDebt uses and only
  // stamp the records whose item resolves to this exact invoice.
  const rows = await db
    .select({
      id: overageBillingRecords.id,
      providerInvoiceItemId: overageBillingRecords.providerInvoiceItemId,
    })
    .from(overageBillingRecords)
    .where(
      and(
        eq(overageBillingRecords.organizationId, organizationId),
        eq(overageBillingRecords.status, "billed"),
        isNull(overageBillingRecords.providerInvoiceId)
      )
    );

  for (const row of rows) {
    if (!row.providerInvoiceItemId) {
      // No item link -> cannot prove this record belongs to the invoice; leave
      // it unattributed so scanAndCreateDebt re-resolves it later.
      continue;
    }
    let invoiceInfo: Awaited<ReturnType<BillingProvider["getInvoiceForItem"]>>;
    try {
      invoiceInfo = await provider.getInvoiceForItem(row.providerInvoiceItemId);
    } catch (error) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        `${LOG_PREFIX} markOverageRecordsPaid: getInvoiceForItem failed`,
        error,
        { overage_record_id: row.id }
      );
      continue;
    }
    if (invoiceInfo?.invoiceId !== invoiceId) {
      continue;
    }
    await db
      .update(overageBillingRecords)
      .set({ providerInvoiceId: invoiceId })
      .where(eq(overageBillingRecords.id, row.id));
  }
}

async function handleInvoicePaid(
  data: BillingWebhookEvent["data"],
  provider: BillingProvider
): Promise<void> {
  const { providerSubscriptionId, invoiceId, providerCustomerId } = data;

  // Clear debt for this invoice regardless of subscription presence
  if (invoiceId) {
    await clearDebtForInvoice(invoiceId);
  }

  if (providerSubscriptionId) {
    console.info(LOG_PREFIX, "invoice.paid - subId:", providerSubscriptionId);

    const sub = await findSubscriptionByProviderId(providerSubscriptionId);

    await db
      .update(organizationSubscriptions)
      .set({
        status: "active",
        billingAlert: null,
        billingAlertUrl: null,
        updatedAt: new Date(),
      })
      .where(
        eq(
          organizationSubscriptions.providerSubscriptionId,
          providerSubscriptionId
        )
      );

    if (sub && invoiceId) {
      await markOverageRecordsPaid(sub.organizationId, invoiceId, provider);
    }

    getMetricsCollector().incrementCounter(MetricNames.BILLING_INVOICE_PAID, {
      plan: parsePlanName(sub?.plan, "free"),
    });
    return;
  }

  // Fallback: standalone invoice (e.g. overage) -- find org by customer ID.
  // Deliberately does NOT set status: "active" because paying an overage invoice
  // is not the same as renewing a subscription. Only subscription invoices restore status.
  if (providerCustomerId) {
    const sub = await findSubscriptionByCustomerId(providerCustomerId);
    if (sub) {
      console.info(
        LOG_PREFIX,
        "invoice.paid - no subId, found org via customerId:",
        providerCustomerId
      );

      await db
        .update(organizationSubscriptions)
        .set({
          billingAlert: null,
          billingAlertUrl: null,
          updatedAt: new Date(),
        })
        .where(
          eq(organizationSubscriptions.organizationId, sub.organizationId)
        );

      if (invoiceId) {
        await markOverageRecordsPaid(sub.organizationId, invoiceId, provider);
      }

      getMetricsCollector().incrementCounter(MetricNames.BILLING_INVOICE_PAID, {
        plan: parsePlanName(sub.plan, "free"),
      });
    }
  }
}

async function handleInvoicePaymentFailed(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceUrl } = data;

  if (!providerSubscriptionId) {
    logWarn(
      `${LOG_PREFIX} invoice.payment_failed - no subscriptionId, skipping`
    );
    return;
  }

  console.info(
    LOG_PREFIX,
    "invoice.payment_failed - subId:",
    providerSubscriptionId
  );

  const sub = await findSubscriptionByProviderId(providerSubscriptionId);

  await db
    .update(organizationSubscriptions)
    .set({
      status: "past_due",
      billingAlert: BILLING_ALERTS.PAYMENT_FAILED,
      billingAlertUrl: invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );

  getMetricsCollector().incrementCounter(MetricNames.BILLING_INVOICE_FAILED, {
    plan: parsePlanName(sub?.plan, "free"),
  });
}

async function handleInvoiceOverdue(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceUrl } = data;

  if (!providerSubscriptionId) {
    logWarn(`${LOG_PREFIX} invoice.overdue - no subscriptionId, skipping`);
    return;
  }

  console.info(LOG_PREFIX, "invoice.overdue - subId:", providerSubscriptionId);

  await db
    .update(organizationSubscriptions)
    .set({
      billingAlert: BILLING_ALERTS.OVERDUE,
      billingAlertUrl: invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );
}

async function handleInvoicePaymentActionRequired(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceUrl } = data;

  if (!providerSubscriptionId) {
    logWarn(
      `${LOG_PREFIX} invoice.payment_action_required - no subscriptionId, skipping`
    );
    return;
  }

  console.info(
    LOG_PREFIX,
    "invoice.payment_action_required - subId:",
    providerSubscriptionId
  );

  await db
    .update(organizationSubscriptions)
    .set({
      billingAlert: BILLING_ALERTS.PAYMENT_ACTION_REQUIRED,
      billingAlertUrl: invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );
}
