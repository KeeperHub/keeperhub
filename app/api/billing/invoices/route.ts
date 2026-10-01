import { NextResponse } from "next/server";
import { getExecutionsUsedForPeriods } from "@/lib/billing/execution-usage";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  getPlanLimits,
  parsePlanName,
  parseTierKey,
} from "@/lib/billing/plans";
import { getOrgSubscription } from "@/lib/billing/plans-server";
import { getBillingProvider } from "@/lib/billing/providers";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const authResult = await requireOrgOwner();
    if ("error" in authResult) {
      return authResult.error;
    }
    const { orgId: activeOrgId } = authResult;

    const sub = await getOrgSubscription(activeOrgId);
    if (!sub?.providerCustomerId) {
      return NextResponse.json({ invoices: [], hasMore: false });
    }

    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const startingAfter = searchParams.get("startingAfter") ?? undefined;
    const limit = Math.min(Math.max(Number(limitParam) || 10, 1), 100);

    const provider = getBillingProvider();
    const result = await provider.listInvoices({
      customerId: sub.providerCustomerId,
      limit,
      startingAfter,
    });

    // Annotate each invoice with the executions used during its own billing
    // period, so usage reconciles with the period the customer was billed on.
    // A closed period comes back from its stored record, carrying the limit
    // that was in force at the time; the current plan is only a fallback for a
    // period that has no record yet, and using it for a closed period would let
    // a later plan change rewrite the limit shown on every past invoice.
    const currentLimits = getPlanLimits(
      parsePlanName(sub.plan),
      parseTierKey(sub.tier),
      sub.planOverrides
    );
    const usage = await getExecutionsUsedForPeriods(
      activeOrgId,
      result.invoices.map((invoice) => ({
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      }))
    );
    const invoices = result.invoices.map((invoice, index) => {
      const periodUsage = usage[index];
      return {
        ...invoice,
        executionsUsed: periodUsage?.executionsUsed ?? 0,
        executionLimit:
          periodUsage?.executionLimit ?? currentLimits.maxExecutionsPerMonth,
      };
    });

    return NextResponse.json({ invoices, hasMore: result.hasMore });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Billing] Invoices error",
      error,
      { endpoint: "/api/billing/invoices", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    );
  }
}
