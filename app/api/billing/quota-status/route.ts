/**
 * Current execution-quota status for the active organization, powering the
 * in-app quota banner.
 *
 * Reads the same lib/billing/quota-threshold signal the quota warning email is
 * sent from, so the banner and the email can never report a different
 * percentage. Owner-scoped to match the email recipients; everyone else gets a
 * null status rather than a 403, since this is a display signal and a failed
 * read should simply render no banner.
 */
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  getOrgQuotaStatus,
  type QuotaThreshold,
} from "@/lib/billing/quota-threshold";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";

type QuotaStatusResponse = {
  status: {
    organizationId: string;
    plan: string;
    planLabel: string;
    used: number;
    limit: number;
    usagePercent: number;
    threshold: QuotaThreshold | null;
    periodStart: string;
    periodEnd: string;
    paygEligible: boolean;
    overageRatePerThousand: number | null;
  } | null;
};

const EMPTY_RESPONSE: QuotaStatusResponse = { status: null };

export async function GET(
  request: Request
): Promise<NextResponse<QuotaStatusResponse>> {
  if (!isBillingEnabled()) {
    return NextResponse.json(EMPTY_RESPONSE);
  }

  try {
    const authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(EMPTY_RESPONSE);
    }

    const activeMember = await auth.api.getActiveMember({
      headers: await headers(),
    });
    if (activeMember?.role !== "owner") {
      return NextResponse.json(EMPTY_RESPONSE);
    }

    const status = await getOrgQuotaStatus(authContext.organizationId);
    if (!status) {
      return NextResponse.json(EMPTY_RESPONSE);
    }

    return NextResponse.json({
      status: {
        organizationId: status.organizationId,
        plan: status.plan,
        planLabel: status.planLabel,
        used: status.used,
        limit: status.limit,
        usagePercent: status.usagePercent,
        threshold: status.threshold,
        periodStart: status.periodStart.toISOString(),
        periodEnd: status.periodEnd.toISOString(),
        paygEligible: status.paygEligible,
        overageRatePerThousand: status.overageRatePerThousand,
      },
    });
  } catch (error) {
    logSystemWarn(
      ErrorCategory.BILLING,
      "[QuotaStatus] degraded; returning empty response",
      error
    );
    return NextResponse.json(EMPTY_RESPONSE);
  }
}
