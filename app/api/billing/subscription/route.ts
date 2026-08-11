import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
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
import {
  getTrialPeriodDays,
  getTrialTier,
  isTrialOfferEligible,
} from "@/lib/billing/trial";
import { db } from "@/lib/db";
import { overageBillingRecords } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type OrganizationAuthContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let authContext: OrganizationAuthContext | null = null;
  try {
    authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { organizationId: activeOrgId } = authContext;

    const sub = await getOrgSubscription(activeOrgId);
    const plan = parsePlanName(sub?.plan);
    const tier = parseTierKey(sub?.tier);
    const limits = getPlanLimits(plan, tier, sub?.planOverrides);
    const resolved = sub?.providerPriceId
      ? resolvePriceId(sub.providerPriceId)
      : undefined;
    const interval = resolved?.interval ?? null;

    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const usageResult = await db.execute<{ count: number }>(
      sql`SELECT
            (
              SELECT COUNT(*)
                FROM workflow_executions we
                JOIN workflows w ON we.workflow_id = w.id
               WHERE w.organization_id = ${activeOrgId}
                 AND we.started_at >= ${startOfMonth.toISOString()}
                 AND we.billable = TRUE
            )
            +
            (
              SELECT COUNT(*)
                FROM direct_executions de
               WHERE de.organization_id = ${activeOrgId}
                 AND de.created_at >= ${startOfMonth.toISOString()}
            ) AS count`
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
      trial: {
        eligible: isTrialOfferEligible(sub),
        days: getTrialPeriodDays(),
        tier: getTrialTier(),
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Subscription query error",
      error,
      {
        endpoint: "/api/billing/subscription",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch subscription" },
      { status: 500 }
    );
  }
}
