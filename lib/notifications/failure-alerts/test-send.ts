import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  organization,
} from "@/lib/db/schema";
import type { FailureAlertDeliveryChannel } from "@/lib/db/schema-failure-alerts";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import {
  loadOrgMembers,
  type OrgMember,
} from "@/lib/notifications/org-recipients";
import { redactErrorSecrets } from "@/lib/utils/redact";
import { TESTS_PER_DAY_PER_ORG, TESTS_PER_MINUTE_PER_USER } from "./constants";
import { appBaseUrl, pauseActorName, renderMessage } from "./messages";
import { resolveRecipientEmails } from "./policy";
import {
  type DeliveryOutcome,
  sendChannelMessage,
  sendEmailMessage,
} from "./senders";
import {
  loadUsableConnections,
  parseChannels,
  SettingsError,
} from "./settings";
import { takeSlots } from "./slots";
import { channelLabel, type TestRequest, type TestResult } from "./view-types";

/**
 * Keeps a sent test in Sent alerts with who sent it. Written already finished,
 * so the outbox never picks it up; a failure here never fails the test.
 */
async function recordTest(params: {
  organizationId: string;
  userId: string;
  members: OrgMember[];
  channel: FailureAlertDeliveryChannel;
  channelId: string | null;
  recipient: string;
  outcome: DeliveryOutcome;
}): Promise<void> {
  const { outcome } = params;
  const now = new Date();
  try {
    await db.insert(failureAlertDeliveries).values({
      dedupKey: `test:${randomUUID()}`,
      organizationId: params.organizationId,
      incidentId: null,
      kind: "test",
      sequence: 0,
      channel: params.channel,
      channelId: params.channelId,
      recipient: params.recipient,
      state: outcome.ok ? "delivered" : "failed",
      attempts: 1,
      nextAttemptAt: now,
      lastStatus: outcome.status ?? null,
      lastError: outcome.ok ? null : redactErrorSecrets(outcome.message),
      deliveredAt: outcome.ok ? now : null,
      context: {
        by: pauseActorName(
          params.members.find((m) => m.userId === params.userId)
        ),
      },
    });
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Could not record a test in Sent alerts",
      error
    );
  }
}

/** Each email a test sends counts toward the org's daily tests; `emails` is unset for chat tests. */
async function checkTestRateLimit(
  organizationId: string,
  userId: string,
  emails?: number
): Promise<void> {
  if (emails !== undefined && emails > TESTS_PER_DAY_PER_ORG) {
    throw new SettingsError(
      `A test can email at most ${TESTS_PER_DAY_PER_ORG} people. Choose fewer people.`,
      429
    );
  }
  const perUser = await takeSlots("user", userId);
  if (!perUser.ok) {
    throw new SettingsError(
      `You can send ${TESTS_PER_MINUTE_PER_USER} tests a minute. Try again in a minute.`,
      429
    );
  }
  const perOrg = await takeSlots("org", organizationId, emails ?? 1);
  if (!perOrg.ok) {
    throw new SettingsError(
      // Some left but too few: only a test emailing several people (emails > 1).
      perOrg.left === 0
        ? "No test messages are left today. Try again tomorrow."
        : `This test would email ${emails} people; ${perOrg.left} test ${perOrg.left === 1 ? "email is" : "emails are"} left today. Choose fewer people, or try again later.`,
      429
    );
  }
}

function classify(outcome: DeliveryOutcome): TestResult["classification"] {
  if (outcome.ok) {
    return "ok";
  }
  return outcome.retryable ? "transient" : "permanent";
}

async function orgName(organizationId: string): Promise<string> {
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return row?.name ?? "your organization";
}

type ChannelTestRequest = Exclude<TestRequest, { channel: "email" }>;

/** Saved channels test with stored values only, so a test clears only the channel it proved. */
async function resolveTarget(
  organizationId: string,
  request: ChannelTestRequest
): Promise<{
  kind: ChannelTestRequest["channel"];
  integrationId: string;
  destination: string;
  channelId?: string;
}> {
  if (request.channelId) {
    const [saved] = await db
      .select({
        id: failureAlertChannels.id,
        kind: failureAlertChannels.kind,
        integrationId: failureAlertChannels.integrationId,
        destination: failureAlertChannels.destination,
      })
      .from(failureAlertChannels)
      .where(
        and(
          eq(failureAlertChannels.id, request.channelId),
          eq(failureAlertChannels.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!saved) {
      throw new SettingsError("That channel no longer exists.", 404);
    }
    return { ...saved, channelId: saved.id };
  }
  const [channel] = await parseChannels(
    [
      {
        integrationId: request.integrationId,
        destination: request.destination,
        role: "always",
      },
    ],
    organizationId
  );
  if (channel.kind !== request.channel) {
    throw new SettingsError(
      `That connection is not a ${request.channel} connection.`
    );
  }
  return channel;
}

async function testEmail(
  organizationId: string,
  userId: string,
  request: Extract<TestRequest, { channel: "email" }>,
  name: string
): Promise<TestResult> {
  const members = await loadOrgMembers(organizationId);
  let recipients: string[];
  if (request.to === "me") {
    const me = members.find((m) => m.userId === userId);
    if (!me?.deliverable) {
      throw new SettingsError(
        "You have no email KeeperHub can reach. Add one in Account security."
      );
    }
    recipients = [me.deliverable];
  } else {
    recipients = resolveRecipientEmails(
      Array.isArray(request.recipientUserIds) ? request.recipientUserIds : null,
      members
    );
    if (recipients.length === 0) {
      throw new SettingsError("Nobody you chose can receive email yet.");
    }
  }
  await checkTestRateLimit(organizationId, userId, recipients.length);
  const started = Date.now();
  const rendered = renderMessage({
    kind: "test",
    orgName: name,
    organizationId,
    appUrl: appBaseUrl(),
    channelLabel: "email",
  });
  let last: DeliveryOutcome = { ok: true, retryable: false, message: "" };
  for (const to of recipients) {
    last = await sendEmailMessage(to, rendered);
    await recordTest({
      organizationId,
      userId,
      members,
      channel: "email",
      channelId: null,
      recipient: to,
      outcome: last,
    });
    if (!last.ok) {
      break;
    }
  }
  return {
    delivered: last.ok,
    classification: classify(last),
    status: last.status,
    message: last.ok
      ? `Test email accepted for ${recipients.join(", ")}.`
      : last.message,
    durationMs: Date.now() - started,
    recipients,
  };
}

/** Test through the real senders; not counted toward the Free plan's emails. */
export async function sendTest(params: {
  organizationId: string;
  userId: string;
  request: TestRequest;
}): Promise<TestResult> {
  const { organizationId, userId, request } = params;
  const name = await orgName(organizationId);
  if (request.channel === "email") {
    return await testEmail(organizationId, userId, request, name);
  }

  const target = await resolveTarget(organizationId, request);
  await checkTestRateLimit(organizationId, userId);
  const started = Date.now();
  const connection = (await loadUsableConnections(organizationId)).find(
    (c) => c.id === target.integrationId
  );
  const label = channelLabel(target.kind, target.destination, connection?.name);
  const rendered = renderMessage({
    kind: "test",
    orgName: name,
    organizationId,
    appUrl: appBaseUrl(),
    channelLabel: label,
  });
  const config = {
    id: target.channelId ?? "test",
    kind: target.kind,
    integrationId: target.integrationId,
    destination: target.destination,
    role: "always" as const,
    pausedAt: null,
  };

  let outcome: DeliveryOutcome;
  if (target.kind === "pagerduty" && request.pagerDutyMode === "page") {
    const dedupKey = `kh-fa-test-${randomUUID()}`;
    outcome = await sendChannelMessage({
      channel: config,
      organizationId,
      rendered,
      dedupKey,
      pagerDutyAction: "trigger",
      details: { test: true },
    });
    if (outcome.ok) {
      await sendChannelMessage({
        channel: config,
        organizationId,
        rendered,
        dedupKey,
        pagerDutyAction: "resolve",
      });
    }
  } else {
    outcome = await sendChannelMessage({
      channel: config,
      organizationId,
      rendered,
      pagerDutyAction: "change",
      details: { test: true },
    });
  }

  await recordTest({
    organizationId,
    userId,
    members: await loadOrgMembers(organizationId),
    channel: target.kind,
    channelId: target.channelId ?? null,
    recipient: target.destination || target.kind,
    outcome,
  });

  if (target.channelId) {
    const now = new Date();
    await db
      .update(failureAlertChannels)
      .set({
        lastTestedAt: now,
        lastTestOk: outcome.ok,
        // A passing test is how a paused channel comes back.
        ...(outcome.ok
          ? { pausedAt: null, pausedReason: null }
          : { lastFailedAt: now, lastError: outcome.message }),
      })
      .where(
        and(
          eq(failureAlertChannels.id, target.channelId),
          eq(failureAlertChannels.organizationId, organizationId)
        )
      );
  }

  let message = outcome.message;
  if (outcome.ok) {
    message =
      target.kind === "pagerduty" && request.pagerDutyMode !== "page"
        ? `Change event accepted by PagerDuty for ${label}. Nobody was paged.`
        : `Test delivered to ${label}.`;
  }
  return {
    delivered: outcome.ok,
    classification: classify(outcome),
    status: outcome.status,
    message,
    durationMs: Date.now() - started,
  };
}
