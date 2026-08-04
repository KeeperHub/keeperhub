import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  deletePaygConfig,
  getPaygConfig,
  upsertPaygConfig,
} from "@/lib/billing/payg/config-store";
import { PAYG_DEFAULT_CHAIN_ID } from "@/lib/billing/payg/constants";
import { getPaygExecutionPriceRaw } from "@/lib/billing/payg/pricing";
import { getPaygTreasuryOrNull } from "@/lib/billing/payg/treasury";
import { getCurrentPaygUsage } from "@/lib/billing/payg/usage";
import {
  isValidUsdcDecimal,
  usdcDecimalToRaw,
  usdcRawToDecimal,
} from "@/lib/billing/payg/usdc";
import { PAYG_PLAN_NAME } from "@/lib/billing/plans";
import { getOrgPlan } from "@/lib/billing/plans-server";
import { requireOrgOwner } from "@/lib/billing/require-org-owner";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type OrganizationAuthContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type PaygStatus = {
  enabled: boolean;
  priceUsdc: string;
  treasuryConfigured: boolean;
  chainId: number;
  caps: { dailyUsdc: string; periodUsdc: string };
  usage: {
    periodStart: string;
    periodEnd: string;
    periodExecutions: number;
    periodSpentUsdc: string;
    dailySpentUsdc: string;
  } | null;
};

async function buildPaygStatus(organizationId: string): Promise<PaygStatus> {
  const config = await getPaygConfig(organizationId);
  const chainId = config?.chainId ?? PAYG_DEFAULT_CHAIN_ID;
  const priceRaw = getPaygExecutionPriceRaw();

  const usage = await getCurrentPaygUsage(organizationId);

  return {
    enabled: config !== null,
    priceUsdc: usdcRawToDecimal(priceRaw),
    treasuryConfigured: getPaygTreasuryOrNull(chainId) !== null,
    chainId,
    caps: {
      dailyUsdc: usdcRawToDecimal(BigInt(config?.dailyCapRaw ?? "0")),
      periodUsdc: usdcRawToDecimal(BigInt(config?.periodCapRaw ?? "0")),
    },
    usage: usage
      ? {
          periodStart: usage.periodStart.toISOString(),
          periodEnd: usage.periodEnd.toISOString(),
          periodExecutions: usage.periodExecutions,
          periodSpentUsdc: usdcRawToDecimal(usage.periodSpentRaw),
          dailySpentUsdc: usdcRawToDecimal(usage.dailySpentRaw),
        }
      : null,
  };
}

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
    return NextResponse.json(await buildPaygStatus(authContext.organizationId));
  } catch (error) {
    logSystemError(ErrorCategory.BILLING, "[PAYG] Status error", error, {
      endpoint: "/api/billing/payg",
      operation: "get",
    });
    return NextResponse.json(
      { error: "Failed to load pay-as-you-go status" },
      { status: 500 }
    );
  }
}

/**
 * Parse a decimal USDC cap into a 6-dp raw string; "" / undefined -> "0" (no
 * cap). Throws on a malformed value so the caller returns 400 rather than
 * silently treating garbage as "0" (which would disable the spend cap).
 */
function parseCap(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "0";
  }
  if (typeof value !== "string" || !isValidUsdcDecimal(value)) {
    throw new Error("Cap must be a decimal USDC string");
  }
  return usdcDecimalToRaw(value).toString();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await requireOrgOwner();
  if ("error" in auth) {
    return auth.error;
  }
  const { orgId, userId } = auth;

  try {
    const body = (await request.json().catch(() => ({}))) as {
      dailyCapUsdc?: string;
      periodCapUsdc?: string;
      chainId?: number;
    };

    let dailyCapRaw: string;
    let periodCapRaw: string;
    try {
      dailyCapRaw = parseCap(body.dailyCapUsdc);
      periodCapRaw = parseCap(body.periodCapUsdc);
    } catch {
      return NextResponse.json(
        { error: "Spending caps must be valid USDC amounts" },
        { status: 400 }
      );
    }

    const chainId = body.chainId ?? PAYG_DEFAULT_CHAIN_ID;
    if (getPaygTreasuryOrNull(chainId) === null) {
      return NextResponse.json(
        { error: "Pay-as-you-go is not available on this network" },
        { status: 400 }
      );
    }

    // PAYG is a free-tier feature: it lets a free org keep running past its
    // included limit. Paid plans have their own executions/overage, so only
    // free-plan orgs may enable it.
    if ((await getOrgPlan(orgId)) !== PAYG_PLAN_NAME) {
      return NextResponse.json(
        { error: "Pay-as-you-go is available on the free plan only" },
        { status: 409 }
      );
    }

    const alreadyEnabled = (await getPaygConfig(orgId)) !== null;
    await upsertPaygConfig({
      organizationId: orgId,
      dailyCapRaw,
      periodCapRaw,
      chainId,
    });

    await recordAuditEvent({
      actor: { userId, organizationId: orgId, authMethod: "session" },
      action: alreadyEnabled ? "payg.caps_updated" : "payg.enabled",
      resourceType: "subscription",
      resourceId: orgId,
      after: { dailyCapRaw, periodCapRaw, chainId },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(await buildPaygStatus(orgId));
  } catch (error) {
    logSystemError(ErrorCategory.BILLING, "[PAYG] Enable error", error, {
      endpoint: "/api/billing/payg",
      operation: "post",
    });
    return NextResponse.json(
      { error: "Failed to update pay-as-you-go settings" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await requireOrgOwner();
  if ("error" in auth) {
    return auth.error;
  }
  const { orgId, userId } = auth;

  try {
    await deletePaygConfig(orgId);

    await recordAuditEvent({
      actor: { userId, organizationId: orgId, authMethod: "session" },
      action: "payg.disabled",
      resourceType: "subscription",
      resourceId: orgId,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(await buildPaygStatus(orgId));
  } catch (error) {
    logSystemError(ErrorCategory.BILLING, "[PAYG] Disable error", error, {
      endpoint: "/api/billing/payg",
      operation: "delete",
    });
    return NextResponse.json(
      { error: "Failed to disable pay-as-you-go" },
      { status: 500 }
    );
  }
}
