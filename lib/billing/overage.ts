import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationSubscriptions,
  overageBillingRecords,
} from "@/lib/db/schema";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { getPlanLimits, PLANS, parsePlanName, parseTierKey } from "./plans";
import { getBillingProvider } from "./providers";

const LOG_PREFIX = "[Overage Billing]";

type OverageResult =
  | { billed: false; reason: string }
  | { billed: true; overageCount: number; totalChargeCents: number };

/**
 * Bill overage executions for an organization's billing period.
 *
 * Idempotent: if a record already exists for the given org + period, it skips.
 * Creates a Stripe invoice item that attaches to the customer's next invoice.
 */
export async function billOverageForOrg(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date
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
               AND we.status <> 'blocked_billing'
          )
          +
          (
            SELECT COUNT(*)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${periodStart.toISOString()}
               AND de.created_at <  ${periodEnd.toISOString()}
               AND de.status <> 'blocked_billing'
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
    const { invoiceItemId } = await provider.createInvoiceItem({
      customerId: sub.providerCustomerId,
      amount: totalChargeCents,
      currency: "usd",
      description: `Overage: ${overageCount.toLocaleString()} executions above ${limits.maxExecutionsPerMonth.toLocaleString()} limit (${plan} plan)`,
      metadata: {
        organizationId,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        overageCount: String(overageCount),
      },
    });

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
    console.error(LOG_PREFIX, "Failed to create invoice item:", message);

    await db
      .update(overageBillingRecords)
      .set({ status: "failed" })
      .where(eq(overageBillingRecords.id, record.id));

    return { billed: false, reason: `provider error: ${message}` };
  }
}
