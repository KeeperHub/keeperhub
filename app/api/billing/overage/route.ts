import { and, eq, lt, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { billOverageForOrg } from "@/lib/billing/overage";
import { db } from "@/lib/db";
import {
  organizationSubscriptions,
  overageBillingRecords,
} from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type SingleOrgBody = {
  scan?: never;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
};

type ScanBody = {
  scan: true;
  organizationId?: never;
  periodStart?: never;
  periodEnd?: never;
};

type RequestBody = SingleOrgBody | ScanBody;

/**
 * Internal POST endpoint for overage billing.
 *
 * Two modes:
 * - Single org: `{ organizationId, periodStart, periodEnd }` -- bill one org
 * - Scan mode: `{ scan: true }` -- find all active subscriptions with ended
 *   periods that haven't been billed yet, then bill each
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const body = JSON.parse(rawBody) as RequestBody;

  if (body.scan) {
    return handleScan();
  }

  if (body.organizationId && body.periodStart && body.periodEnd) {
    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);

    if (
      Number.isNaN(periodStart.getTime()) ||
      Number.isNaN(periodEnd.getTime())
    ) {
      return NextResponse.json(
        { error: "Invalid date format for periodStart or periodEnd" },
        { status: 400 }
      );
    }

    const result = await billOverageForOrg(
      body.organizationId,
      periodStart,
      periodEnd
    );
    return NextResponse.json(result);
  }

  return NextResponse.json(
    {
      error:
        "Provide { scan: true } or { organizationId, periodStart, periodEnd }",
    },
    { status: 400 }
  );
}

type OrgBillingResult = {
  organizationId: string;
  result: { billed: boolean; reason?: string };
};

async function safeBillOrg(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  errorLabel: string
): Promise<OrgBillingResult> {
  try {
    const result = await billOverageForOrg(
      organizationId,
      periodStart,
      periodEnd
    );
    return { organizationId, result };
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[Billing] ${errorLabel} for org ${organizationId}`,
      error,
      { endpoint: "/api/billing/overage", operation: "billOrg" }
    );
    return {
      organizationId,
      result: { billed: false, reason: errorLabel },
    };
  }
}

async function handleScan(): Promise<NextResponse> {
  const now = new Date();

  // Find subscriptions where the billing period has ended.
  // Include both active and canceled: a canceled sub may still have unbilled
  // overage from its final period.
  const subs = await db
    .select({
      organizationId: organizationSubscriptions.organizationId,
      periodStart: organizationSubscriptions.currentPeriodStart,
      periodEnd: organizationSubscriptions.currentPeriodEnd,
    })
    .from(organizationSubscriptions)
    .where(
      and(
        or(
          eq(organizationSubscriptions.status, "active"),
          eq(organizationSubscriptions.status, "canceled")
        ),
        lt(organizationSubscriptions.currentPeriodEnd, now)
      )
    );

  const results: OrgBillingResult[] = [];

  // Track orgs processed in loop 1 to avoid double-processing in loop 2
  const processedOrgPeriods = new Set<string>();

  for (const sub of subs) {
    if (sub.periodStart === null || sub.periodEnd === null) {
      continue;
    }

    const entry = await safeBillOrg(
      sub.organizationId,
      sub.periodStart,
      sub.periodEnd,
      "Overage scan failed"
    );
    results.push(entry);
    processedOrgPeriods.add(
      `${sub.organizationId}:${sub.periodStart.toISOString()}:${sub.periodEnd.toISOString()}`
    );
  }

  // Retry pending/failed overage records that were created but not successfully
  // billed (e.g. if billOverageForOrg failed after inserting the record).
  // These records store period dates independently from the subscription row.
  const failedRecords = await db
    .select({
      organizationId: overageBillingRecords.organizationId,
      periodStart: overageBillingRecords.periodStart,
      periodEnd: overageBillingRecords.periodEnd,
    })
    .from(overageBillingRecords)
    .where(
      or(
        eq(overageBillingRecords.status, "pending"),
        eq(overageBillingRecords.status, "failed")
      )
    );

  let retried = 0;
  for (const record of failedRecords) {
    const key = `${record.organizationId}:${record.periodStart.toISOString()}:${record.periodEnd.toISOString()}`;
    if (processedOrgPeriods.has(key)) {
      continue;
    }
    const entry = await safeBillOrg(
      record.organizationId,
      record.periodStart,
      record.periodEnd,
      "Overage retry failed"
    );
    results.push(entry);
    retried += 1;
  }

  return NextResponse.json({
    scanned: subs.length,
    retried,
    results,
  });
}
