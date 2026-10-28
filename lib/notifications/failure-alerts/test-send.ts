import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { failureAlertChannels, organization } from "@/lib/db/schema";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import { createSlidingWindowLimiter } from "@/lib/rate-limit/sliding-window";
import { getRedis } from "@/lib/redis";
import { TESTS_PER_DAY_PER_ORG, TESTS_PER_MINUTE_PER_USER } from "./constants";
import { renderMessage } from "./messages";
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
import { channelLabel, type TestRequest, type TestResult } from "./view-types";

// Fallbacks for a deployment without Redis: per pod, so looser, never open.
const userLimiter = createSlidingWindowLimiter({
  limit: TESTS_PER_MINUTE_PER_USER,
  windowMs: 60_000,
});
const orgLimiter = createSlidingWindowLimiter({
  limit: TESTS_PER_DAY_PER_ORG,
  windowMs: 24 * 60 * 60 * 1000,
});

async function underLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  fallback: ReturnType<typeof createSlidingWindowLimiter>
): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      // Checked on every call rather than only on the first, so a key whose
      // expiry failed to set once heals itself instead of limiting for good.
      if ((await redis.ttl(key)) < 0) {
        await redis.expire(key, windowSeconds);
      }
      return count <= limit;
    } catch {
      // Fall through to the in-memory window.
    }
  }
  return fallback.check(key).allowed;
}

async function checkTestRateLimit(
  organizationId: string,
  userId: string
): Promise<void> {
  const perUser = await underLimit(
    `failure-alert-test:user:${userId}`,
    TESTS_PER_MINUTE_PER_USER,
    60,
    userLimiter
  );
  if (!perUser) {
    throw new SettingsError(
      `You can send ${TESTS_PER_MINUTE_PER_USER} tests a minute. Try again in a minute.`,
      429
    );
  }
  const perOrg = await underLimit(
    `failure-alert-test:org:${organizationId}`,
    TESTS_PER_DAY_PER_ORG,
    24 * 60 * 60,
    orgLimiter
  );
  if (!perOrg) {
    throw new SettingsError(
      `This organization has used its ${TESTS_PER_DAY_PER_ORG} tests for today. Try again tomorrow.`,
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

/**
 * What to test. A saved channel is tested with its own stored connection and
 * destination, never values from the request, so a test can only clear the
 * pause on the channel it actually proved works.
 */
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
  await checkTestRateLimit(organizationId, userId);
  const started = Date.now();
  const rendered = renderMessage({
    kind: "test",
    orgName: name,
    channelLabel: "email",
  });
  let last: DeliveryOutcome = { ok: true, retryable: false, message: "" };
  for (const to of recipients) {
    last = await sendEmailMessage(to, rendered);
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

/**
 * Send one test through the same senders real alerts use, so a passing test
 * proves the real path. Validated before the rate limit is spent, and never
 * counted toward the Free plan's emails.
 */
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
