/**
 * Scheduled execution-quota threshold scan.
 *
 * Finds every organization that has reached 80% or 100% of its monthly
 * execution quota and emails the owners once per threshold per quota month.
 * Authenticated as an internal service (HMAC) and invoked hourly by the
 * `quota-threshold-scan` k8s CronJob via deploy/scripts/reaper.sh.
 *
 * This is a backstop, not the primary trigger. Admission notifies inline the
 * moment an execution crosses a threshold, which covers everything running
 * through the app. The scan exists for executor-driven runs (schedule, event,
 * block), which never reach that path.
 *
 * Hourly rather than every few minutes because the first query here is a
 * month-wide COUNT grouped by organization, the shape of aggregate that has
 * already cost this database once. The unique row in
 * execution_quota_notifications means a run normally finds nothing to claim,
 * so the only thing frequency buys is how soon an executor-driven crossing is
 * noticed, bounded here at an hour.
 */
import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { findOrgsAtQuotaThreshold } from "@/lib/billing/quota-threshold";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  notifyOrgQuotaThreshold,
  type QuotaNotificationResult,
} from "@/lib/notifications/quota-threshold";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  // With billing off there is no plan to upgrade to and no wallet to charge,
  // so the email has nothing to offer.
  if (!isBillingEnabled()) {
    return NextResponse.json({
      orgsScanned: 0,
      sent: 0,
      skipped: 0,
      errors: 0,
      notified: [],
      disabled: true,
    });
  }

  const now = new Date();
  const notified: QuotaNotificationResult[] = [];
  let orgsScanned = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
    const candidates = await findOrgsAtQuotaThreshold(now);

    for (const status of candidates) {
      orgsScanned++;
      try {
        const result = await notifyOrgQuotaThreshold(status, appUrl);
        if (result) {
          notified.push(result);
        } else {
          skipped++;
        }
      } catch (error) {
        errors++;
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[QuotaThresholdScan] Failed to notify org",
          error,
          {
            organization_id: status.organizationId,
            threshold: String(status.threshold),
          }
        );
      }
    }

    return NextResponse.json({
      orgsScanned,
      sent: notified.length,
      skipped,
      errors,
      notified,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[QuotaThresholdScan] Failed to run quota scan",
      error,
      {
        endpoint: "/api/internal/quota-threshold-scan",
        operation: "get",
      }
    );
    return NextResponse.json({ error: "Quota scan failed" }, { status: 500 });
  }
}
