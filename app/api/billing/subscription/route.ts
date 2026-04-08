import { desc, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  getGasCreditBalance,
  getGasCreditCaps,
} from "@/lib/billing/gas-credits";
import {
  getPlanLimits,
  parsePlanName,
  parseTierKey,
} from "@/lib/billing/plans";
import { getOrgSubscription, resolvePriceId } from "@/lib/billing/plans-server";
import { db } from "@/lib/db";
import { overageBillingRecords } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getActiveOrgId } from "@/lib/middleware/org-context";

export async function GET(): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const activeOrgId = getActiveOrgId(session);
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const sub = await getOrgSubscription(activeOrgId);
    const plan = parsePlanName(sub?.plan);
    const tier = parseTierKey(sub?.tier);
    const limits = getPlanLimits(plan, tier);
    const resolved = sub?.providerPriceId
      ? resolvePriceId(sub.providerPriceId)
      : undefined;
    const interval = resolved?.interval ?? null;

    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const usageResult = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int as count
          FROM workflow_executions we
          JOIN workflows w ON we.workflow_id = w.id
          WHERE w.organization_id = ${activeOrgId}
          AND we.started_at >= ${startOfMonth.toISOString()}`
    );
    const executionsUsed = usageResult[0]?.count ?? 0;

    const recentOverage = await db
      .select({
        periodStart: overageBillingRecords.periodStart,
        periodEnd: overageBillingRecords.periodEnd,
        overageCount: overageBillingRecords.overageCount,
        totalChargeCents: overageBillingRecords.totalChargeCents,
        status: overageBillingRecords.status,
        createdAt: overageBillingRecords.createdAt,
        providerInvoiceId: overageBillingRecords.providerInvoiceId,
      })
      .from(overageBillingRecords)
      .where(eq(overageBillingRecords.organizationId, activeOrgId))
      .orderBy(desc(overageBillingRecords.createdAt))
      .limit(5);

    const gasBalance = await getGasCreditBalance(activeOrgId);
    const gasCreditCaps = getGasCreditCaps();

    return NextResponse.json({
      usage: {
        executionsUsed,
        executionLimit: limits.maxExecutionsPerMonth,
      },
      gasCredits: {
        totalCents: gasBalance.totalCents,
        usedCents: gasBalance.usedCents,
        remainingCents: gasBalance.remainingCents,
      },
      gasCreditCaps,
      overageCharges: recentOverage,
      subscription: sub
        ? {
            plan: sub.plan,
            tier: sub.tier,
            interval,
            status: sub.status,
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            billingAlert: sub.billingAlert ?? null,
            billingAlertUrl: sub.billingAlertUrl ?? null,
          }
        : {
            plan: "free",
            tier: null,
            interval: null,
            status: "active",
            currentPeriodStart: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            billingAlert: null,
            billingAlertUrl: null,
          },
      limits,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Subscription query error",
      error,
      { endpoint: "/api/billing/subscription", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to fetch subscription" },
      { status: 500 }
    );
  }
}
