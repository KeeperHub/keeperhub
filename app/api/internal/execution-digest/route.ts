/**
 * Scheduled workflow execution digest (paid-only email).
 *
 * Sends each opted-in org a summary of its workflow executions and failures to
 * the subscribed members, for each cadence the org subscribes to. Authenticated
 * as an internal service (HMAC) and invoked by the
 * `execution-digest` k8s CronJob, which runs daily at 14:00 UTC via
 * deploy/scripts/digest-cron.sh. Daily cadence sends every run; weekly sends
 * only on Tuesdays; monthly sends only on the 1st (reporting the previous
 * calendar month) -- so weekly digests land Tuesday 14:00 UTC and monthly
 * digests land the 1st at 14:00 UTC.
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  member,
  organization,
  users,
  workflowExecutionDigestSettings,
} from "@/lib/db/schema";
import { sendWorkflowExecutionDigestEmail } from "@/lib/email";
import { isFeatureEnabledForOrg } from "@/lib/features/server";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import type { DigestCadence } from "@/lib/notifications/execution-digest";
import {
  digestWindow,
  getOrgExecutionDigest,
  isDigestDue,
  SUBSCRIBABLE_ROLES,
} from "@/lib/notifications/execution-digest";

const FEATURE_ID = "notifications.execution-digest" as const;

type DigestRow = {
  organizationId: string;
  orgName: string;
  cadences: DigestCadence[];
  subscriberUserIds: string[];
  lastSent: Partial<Record<DigestCadence, string>>;
};

type NotifiedOrg = {
  organizationId: string;
  name: string;
  cadences: DigestCadence[];
  recipients: number;
};

async function resolveSubscriberEmails(
  organizationId: string,
  subscriberUserIds: string[]
): Promise<string[]> {
  if (subscriberUserIds.length === 0) {
    return [];
  }
  // Re-check the role at send time: a subscriber downgraded to member after
  // being saved must stop receiving the digest.
  const rows = await db
    .select({ email: users.email })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.role, SUBSCRIBABLE_ROLES),
        inArray(member.userId, subscriberUserIds)
      )
    );
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function processOrg(
  row: DigestRow,
  now: Date
): Promise<NotifiedOrg | null> {
  const dueCadences = row.cadences.filter((cadence) => {
    const last = row.lastSent[cadence];
    return isDigestDue(cadence, last ? new Date(last) : null, now);
  });
  if (dueCadences.length === 0) {
    return null;
  }
  // Re-check plan at send time so a downgraded org stops receiving digests.
  if (!(await isFeatureEnabledForOrg(FEATURE_ID, row.organizationId))) {
    return null;
  }

  const emails = await resolveSubscriberEmails(
    row.organizationId,
    row.subscriberUserIds
  );
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

  const nextLastSent = { ...row.lastSent };
  const sentCadences: DigestCadence[] = [];

  for (const cadence of dueCadences) {
    const { since, until } = digestWindow(cadence, now);
    const digest = await getOrgExecutionDigest(
      row.organizationId,
      since,
      until
    );
    // Skipped runs are excluded from `total`, but an org whose triggers were
    // all refused is exactly the one that needs the email, so they still count
    // as activity here.
    if (digest.total === 0 && digest.skipped === 0) {
      // No activity this window; send nothing and leave this cadence's last-sent
      // so the next run re-evaluates once there is something to report.
      continue;
    }

    for (const to of emails) {
      await sendWorkflowExecutionDigestEmail({
        to,
        orgName: row.orgName,
        organizationId: row.organizationId,
        cadence,
        since,
        until,
        appUrl,
        stats: {
          total: digest.total,
          success: digest.success,
          error: digest.error,
          skipped: digest.skipped,
          distinctWorkflows: digest.distinctWorkflows,
          transactionCount: digest.transactionCount,
          gasUsedWei: digest.gasUsedWei,
          sponsoredTransactionCount: digest.sponsoredTransactionCount,
        },
        topFailing: digest.topFailing,
        mostExecuted: digest.mostExecuted,
        topSkipped: digest.topSkipped,
      });
    }

    nextLastSent[cadence] = now.toISOString();
    sentCadences.push(cadence);
  }

  if (sentCadences.length === 0) {
    return null;
  }

  await db
    .update(workflowExecutionDigestSettings)
    .set({ lastSent: nextLastSent, updatedAt: now })
    .where(
      eq(workflowExecutionDigestSettings.organizationId, row.organizationId)
    );

  return {
    organizationId: row.organizationId,
    name: row.orgName,
    cadences: sentCadences,
    recipients: emails.length,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const now = new Date();
  const notified: NotifiedOrg[] = [];
  let orgsProcessed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const rows = await db
      .select({
        organizationId: workflowExecutionDigestSettings.organizationId,
        orgName: organization.name,
        cadences: workflowExecutionDigestSettings.cadences,
        subscriberUserIds: workflowExecutionDigestSettings.subscriberUserIds,
        lastSent: workflowExecutionDigestSettings.lastSent,
      })
      .from(workflowExecutionDigestSettings)
      .innerJoin(
        organization,
        eq(organization.id, workflowExecutionDigestSettings.organizationId)
      )
      .where(eq(workflowExecutionDigestSettings.enabled, true));

    for (const row of rows) {
      orgsProcessed++;
      try {
        const result = await processOrg(row, now);
        if (result) {
          notified.push(result);
        } else {
          skipped++;
        }
      } catch (error) {
        errors++;
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[ExecutionDigest] Failed to process org digest",
          error,
          { organization_id: row.organizationId }
        );
      }
    }

    return NextResponse.json({
      orgsProcessed,
      sent: notified.length,
      skipped,
      errors,
      notified,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[ExecutionDigest] Failed to run digest job",
      error,
      { endpoint: "/api/internal/execution-digest", operation: "get" }
    );
    return NextResponse.json({ error: "Digest run failed" }, { status: 500 });
  }
}
