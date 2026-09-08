import "server-only";

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  executionDebt,
  organizationSubscriptions,
  overageBillingRecords,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn, logUserError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { getPlanLimits, PLANS, parsePlanName, parseTierKey } from "./plans";
import type {
  BillingProvider,
  CreateInvoiceItemParams,
  CreateInvoiceItemResult,
} from "./provider";
import { getBillingProvider } from "./providers";

const LOG_PREFIX = "[Overage Billing]";

// The invoice and the items on it must agree; an invoice cannot mix currencies.
const BILLING_CURRENCY = "usd";

type OverageResult =
  | { billed: false; reason: string }
  | { billed: true; overageCount: number; totalChargeCents: number };

/**
 * Create the invoice item on `invoiceId`, retrying unattached if that fails.
 *
 * Attaching only works while the invoice is still a draft. If it finalized
 * first the attached call is rejected, and the retry keeps the charge as a
 * pending item on the following invoice rather than dropping it.
 *
 * Each attempt carries its own idempotency key, so repeating either one returns
 * the item it already made rather than a second one. The keys have to differ
 * because the provider refuses a key replayed with different parameters, and
 * the two attempts differ by exactly the invoice they attach to.
 *
 * The retry runs only when the provider refused the request outright, which
 * means it created nothing. After a transport failure the item may exist and
 * only the response was lost, so retrying under the other key would bill twice.
 */
async function createItemWithFallback(
  provider: BillingProvider,
  params: Omit<CreateInvoiceItemParams, "invoiceId" | "idempotencyKey">,
  invoiceId: string | undefined,
  organizationId: string,
  idempotencyKey: string
): Promise<CreateInvoiceItemResult> {
  if (!invoiceId) {
    return await provider.createInvoiceItem({ ...params, idempotencyKey });
  }

  try {
    return await provider.createInvoiceItem({
      ...params,
      invoiceId,
      idempotencyKey: `${idempotencyKey}-inv`,
    });
  } catch (error) {
    if (!provider.wasRejectedWithoutCreating(error)) {
      throw error;
    }

    logSystemWarn(
      ErrorCategory.BILLING,
      `${LOG_PREFIX} Could not attach to the closing invoice, falling back to the next one`,
      error,
      { org_id: organizationId }
    );
    return await provider.createInvoiceItem({ ...params, idempotencyKey });
  }
}

/**
 * Bill overage executions for an organization's billing period.
 *
 * Idempotent: if a record already exists for the given org + period, it skips.
 *
 * Pass `invoiceId` (the still-draft renewal invoice for the cycle that just
 * closed) to put the charge on that invoice, so the org pays its overage on the
 * same invoice that closes the period. Without it the item is left pending and
 * the provider only sweeps it into the following cycle's invoice, a full
 * billing cycle later.
 */
export async function billOverageForOrg(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  options?: { invoiceId?: string }
): Promise<OverageResult> {
  const sub = await db.query.organizationSubscriptions.findFirst({
    where: eq(organizationSubscriptions.organizationId, organizationId),
  });

  if (!sub) {
    return { billed: false, reason: "no subscription" };
  }

  const plan = parsePlanName(sub.plan);
  const tier = parseTierKey(sub.tier);
  const planDef = PLANS[plan];

  if (!planDef.overage.enabled) {
    return { billed: false, reason: "overage not enabled for plan" };
  }

  if (!sub.providerCustomerId) {
    return { billed: false, reason: "no provider customer ID" };
  }

  const limits = getPlanLimits(plan, tier, sub.planOverrides);
  if (limits.maxExecutionsPerMonth === -1) {
    return { billed: false, reason: "unlimited plan" };
  }

  // Idempotency check
  const existing = await db.query.overageBillingRecords.findFirst({
    where: and(
      eq(overageBillingRecords.organizationId, organizationId),
      eq(overageBillingRecords.periodStart, periodStart),
      eq(overageBillingRecords.periodEnd, periodEnd)
    ),
  });

  if (existing) {
    return { billed: false, reason: "already billed for this period" };
  }

  // Count executions for the period (workflow + direct executions both count
  // toward the monthly tier; mirror lib/billing/plans-server.ts#checkExecutionLimit)
  const result = await db.execute<{ count: number }>(
    sql`SELECT
          (
            SELECT COUNT(*)
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${periodStart.toISOString()}
               AND we.started_at <  ${periodEnd.toISOString()}
               AND we.billable = TRUE
          )
          +
          (
            SELECT COUNT(*)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${periodStart.toISOString()}
               AND de.created_at <  ${periodEnd.toISOString()}
          ) AS count`
  );

  const totalExecutions = result[0]?.count ?? 0;
  const overageCount = Math.max(
    0,
    totalExecutions - limits.maxExecutionsPerMonth
  );

  if (overageCount === 0) {
    return { billed: false, reason: "no overage" };
  }

  const perExecutionCents = (planDef.overage.ratePerThousand * 100) / 1000;
  const totalChargeCents = Math.round(overageCount * perExecutionCents);

  // Insert record as pending
  const [record] = await db
    .insert(overageBillingRecords)
    .values({
      organizationId,
      periodStart,
      periodEnd,
      executionLimit: limits.maxExecutionsPerMonth,
      totalExecutions,
      overageCount,
      overageRateCents: Math.round(perExecutionCents * 1000),
      totalChargeCents,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning();

  // If conflict (race condition), another process already handled it
  if (!record) {
    return { billed: false, reason: "already billed for this period" };
  }

  try {
    const provider = getBillingProvider();
    const itemParams = {
      customerId: sub.providerCustomerId,
      amount: totalChargeCents,
      currency: BILLING_CURRENCY,
      description: `Overage: ${overageCount.toLocaleString()} executions above ${limits.maxExecutionsPerMonth.toLocaleString()} limit (${plan} plan)`,
      metadata: {
        organizationId,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        overageCount: String(overageCount),
      },
    };

    // Keyed on the record, which the unique index already pins to one
    // organization and period, so a repeat of any attempt returns the item it
    // already made instead of creating another.
    const { invoiceItemId } = await createItemWithFallback(
      provider,
      itemParams,
      options?.invoiceId,
      organizationId,
      `overage-${record.id}`
    );

    await db
      .update(overageBillingRecords)
      .set({
        status: "billed",
        providerInvoiceItemId: invoiceItemId,
      })
      .where(eq(overageBillingRecords.id, record.id));

    getMetricsCollector().incrementCounter(
      MetricNames.BILLING_OVERAGE_CHARGED,
      { plan }
    );

    return { billed: true, overageCount, totalChargeCents };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `${LOG_PREFIX} Failed to create invoice item`,
      error
    );

    await db
      .update(overageBillingRecords)
      .set({ status: "failed" })
      .where(eq(overageBillingRecords.id, record.id));

    return { billed: false, reason: `provider error: ${message}` };
  }
}

type FinalPeriodResult =
  | { collected: true; totalChargeCents: number }
  // invoiceId is set only when an invoice was raised but not paid, i.e. the
  // amount is owed rather than there being nothing to bill.
  | { collected: false; reason: string; invoiceId?: string };

/**
 * Bill and immediately collect a closing period's overage for an organization
 * whose subscription is ending.
 *
 * The normal path attaches overage to the invoice that closes the period, but a
 * subscription that ends produces no such invoice, so the excess would never be
 * charged. This opens a standalone invoice instead, deliberately not tied to
 * the subscription, so it carries the overage line and nothing else: no plan
 * fee, no proration.
 *
 * A declined card leaves the invoice open rather than raising. The amount stays
 * owed and the debt scan turns it into an execution-debt record once the grace
 * period passes.
 */
export async function collectFinalPeriodOverage(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  customerId: string
): Promise<FinalPeriodResult> {
  const provider = getBillingProvider();

  const { invoiceId } = await provider.createDraftInvoice(
    customerId,
    BILLING_CURRENCY
  );

  const result = await billOverageForOrg(
    organizationId,
    periodStart,
    periodEnd,
    { invoiceId }
  );

  if (!result.billed) {
    await provider.deleteDraftInvoice(invoiceId);
    return { collected: false, reason: result.reason };
  }

  const collection = await provider.finalizeAndCollectInvoice(invoiceId);

  if (!collection.paid) {
    logSystemWarn(
      ErrorCategory.BILLING,
      `${LOG_PREFIX} Final-period invoice was not collected; amount stays owed`,
      new Error(collection.failureReason ?? "collection failed"),
      { org_id: organizationId }
    );
    return {
      collected: false,
      reason: collection.failureReason ?? "collection failed",
      invoiceId: collection.invoiceId,
    };
  }

  return { collected: true, totalChargeCents: result.totalChargeCents };
}

type SettleableRecord = {
  providerInvoiceItemId: string | null;
  providerInvoiceId: string | null;
};

/**
 * Find the invoice a record was billed onto.
 *
 * A stamped record names its invoice directly. An unstamped one has to be
 * traced through its item, which the provider can no longer resolve once the
 * item has been consumed into a finalized invoice.
 */
async function resolveRecordInvoice(
  row: SettleableRecord,
  provider: BillingProvider
): Promise<{ invoiceId: string; status: string; paid: boolean } | undefined> {
  if (row.providerInvoiceId) {
    const status = await provider.getInvoiceStatus(row.providerInvoiceId);
    return {
      invoiceId: row.providerInvoiceId,
      status: status.status,
      paid: status.paid,
    };
  }

  if (!row.providerInvoiceItemId) {
    return undefined;
  }

  return await provider.getInvoiceForItem(row.providerInvoiceItemId);
}

/**
 * Settle any overage an organization left unpaid, called when it subscribes
 * again.
 *
 * Cancelling does not clear what was already run up: the invoice stays open and
 * the debt record stays active. Coming back is the point where a payment method
 * exists again, so this is where the outstanding amount gets another attempt.
 * Records already attributed to a paid invoice are skipped.
 */
export async function collectOutstandingOverage(
  organizationId: string,
  provider: BillingProvider
): Promise<{ attempted: number; collected: number }> {
  // Unattributed records are the usual case. A record the debt scan already
  // stamped is included too: stamping only means the invoice was resolved, not
  // that it was paid, and skipping those leaves the debt that gates this
  // organization with no way to ever settle.
  const rows = await db
    .select({
      id: overageBillingRecords.id,
      providerInvoiceItemId: overageBillingRecords.providerInvoiceItemId,
      providerInvoiceId: overageBillingRecords.providerInvoiceId,
    })
    .from(overageBillingRecords)
    .leftJoin(
      executionDebt,
      and(
        eq(executionDebt.overageRecordId, overageBillingRecords.id),
        eq(executionDebt.status, "active")
      )
    )
    .where(
      and(
        eq(overageBillingRecords.organizationId, organizationId),
        eq(overageBillingRecords.status, "billed"),
        or(
          isNull(overageBillingRecords.providerInvoiceId),
          isNotNull(executionDebt.id)
        )
      )
    );

  let attempted = 0;
  let collected = 0;

  for (const row of rows) {
    try {
      const invoice = await resolveRecordInvoice(row, provider);
      if (!invoice) {
        continue;
      }

      if (invoice.paid) {
        await db
          .update(overageBillingRecords)
          .set({ providerInvoiceId: invoice.invoiceId })
          .where(eq(overageBillingRecords.id, row.id));
        continue;
      }

      // A draft is still being assembled by the provider. Finalizing it here
      // would charge a renewal invoice early, before the lines it is waiting on
      // are added. Only an already-open invoice is ours to collect.
      if (invoice.status === "draft") {
        continue;
      }

      attempted += 1;
      const result = await provider.finalizeAndCollectInvoice(
        invoice.invoiceId
      );
      if (result.paid) {
        collected += 1;
      }
    } catch (error) {
      // One unsettleable record must not stop the rest, nor block the checkout
      // that triggered this.
      logSystemWarn(
        ErrorCategory.BILLING,
        `${LOG_PREFIX} Could not settle an outstanding overage record`,
        error,
        { org_id: organizationId }
      );
    }
  }

  return { attempted, collected };
}
