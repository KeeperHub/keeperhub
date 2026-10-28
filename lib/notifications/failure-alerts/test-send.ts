import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { failureAlertChannels, organization } from "@/lib/db/schema";
import type { FailureAlertChannelKind } from "@/lib/db/schema-failure-alerts";
import { createSlidingWindowLimiter } from "@/lib/rate-limit/sliding-window";
import { getRedis } from "@/lib/redis";
import { TESTS_PER_DAY_PER_ORG, TESTS_PER_MINUTE_PER_USER } from "./constants";
import { renderMessage } from "./messages";
import { channelLabel } from "./outbox";
import { loadOrgMembers, resolveRecipientEmails } from "./policy";
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

export type TestRequest =
  | {
      channel: "email";
      to: "me" | "recipients";
      recipientUserIds?: string[];
    }
  | {
      channel: FailureAlertChannelKind;
      integrationId: string;
      destination: string;
      /** A saved channel, so its health is updated by the result. */
      channelId?: string;
      /** PagerDuty: "change" pages nobody; "page" opens and resolves one. */
      pagerDutyMode?: "change" | "page";
    };

export type TestResult = {
  delivered: boolean;
  classification: "ok" | "transient" | "permanent";
  status?: number;
  message: string;
  durationMs: number;
  recipients?: string[];
};

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
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }
      return count <= limit;
    } catch {
      // Fall through to the in-memory window.
    }
  }
  return fallback.check(key).allowed;
}

export async function checkTestRateLimit(
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

/**
 * Send one test through the same senders real alerts use, so a passing test
 * proves the real path. Tests never count toward the Free plan's emails.
 */
export async function sendTest(params: {
  organizationId: string;
  userId: string;
  request: TestRequest;
}): Promise<TestResult> {
  const { organizationId, userId, request } = params;
  const started = Date.now();
  const name = await orgName(organizationId);

  if (request.channel === "email") {
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
        Array.isArray(request.recipientUserIds)
          ? request.recipientUserIds
          : null,
        members
      );
      if (recipients.length === 0) {
        throw new SettingsError("Nobody you chose can receive email yet.");
      }
    }
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
  const connection = (await loadUsableConnections(organizationId)).find(
    (c) => c.id === channel.integrationId
  );
  const label = channelLabel(
    channel.kind,
    channel.destination,
    connection?.name
  );
  const rendered = renderMessage({
    kind: "test",
    orgName: name,
    channelLabel: label,
  });
  const config = {
    id: request.channelId ?? "test",
    kind: channel.kind,
    integrationId: channel.integrationId,
    destination: channel.destination,
    role: channel.role,
    pausedAt: null,
  };

  let outcome: DeliveryOutcome;
  if (channel.kind === "pagerduty" && request.pagerDutyMode === "page") {
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

  if (request.channelId) {
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
          eq(failureAlertChannels.id, request.channelId),
          eq(failureAlertChannels.organizationId, organizationId)
        )
      );
  }

  let message = outcome.message;
  if (outcome.ok) {
    message =
      channel.kind === "pagerduty" && request.pagerDutyMode !== "page"
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
