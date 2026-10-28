import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { sendEmailDetailed } from "@/lib/email";
import { sendBackupNotification } from "@/lib/notifications/backup-channel";
import {
  isValidDiscordWebhookUrl,
  SLACK_AUTH_TEST_URL,
  telegramGetChatUrl,
} from "@/lib/notifications/messaging-endpoints";
import { SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { isRetryableHttpStatus } from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "@/plugins/pagerduty/credentials";
import {
  postEvent,
  resolveRoutingKey,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import type { RenderedMessage } from "./messages";
import type { ChannelConfig } from "./policy";

/**
 * One attempt to deliver one message, and what it means for the next step.
 * Never throws: the outbox records every outcome.
 */
export type DeliveryOutcome = {
  ok: boolean;
  status?: number;
  /** Worth another attempt: a timeout, a rate limit, a 5xx. */
  retryable: boolean;
  retryAfterMs?: number;
  /** Ours to fix (our email key), so our on-call hears about it. */
  platformFault?: boolean;
  message: string;
};

/** Egress attribution for the SSRF guard and its metrics. */
const PLUGIN = "failure-alerts";
const REQUEST_TIMEOUT_MS = 10_000;

const DELIVERED: DeliveryOutcome = {
  ok: true,
  retryable: false,
  message: "Delivered",
};

export async function sendEmailMessage(
  to: string,
  rendered: RenderedMessage
): Promise<DeliveryOutcome> {
  const result = await sendEmailDetailed({
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  if (result.ok) {
    return { ...DELIVERED, status: result.status };
  }
  return {
    ok: false,
    status: result.status,
    retryable: result.retryable,
    retryAfterMs: result.retryAfterMs,
    platformFault: result.platformFault,
    message: result.error ?? "The email could not be sent.",
  };
}

/** Credentials only resolve for a connection shared with the whole org. */
async function orgCredentials(
  channel: ChannelConfig,
  organizationId: string
): Promise<Record<string, string | undefined> | null> {
  const credentials = await fetchCredentials(channel.integrationId, {
    organizationId,
  });
  return Object.keys(credentials).length > 0 ? credentials : null;
}

const UNUSABLE_CONNECTION: DeliveryOutcome = {
  ok: false,
  retryable: false,
  message:
    "The connection was deleted, is no longer shared with the organization, or its creator was deactivated.",
};

export type PagerDutyAction = "trigger" | "resolve" | "change";

export async function sendChannelMessage(params: {
  channel: ChannelConfig;
  organizationId: string;
  rendered: RenderedMessage;
  /** PagerDuty only: one incident per failing streak, kept across retries. */
  dedupKey?: string;
  pagerDutyAction?: PagerDutyAction;
  details?: Record<string, unknown>;
}): Promise<DeliveryOutcome> {
  const { channel, organizationId, rendered } = params;
  try {
    const credentials = await orgCredentials(channel, organizationId);
    if (!credentials) {
      return UNUSABLE_CONNECTION;
    }
    if (channel.kind === "pagerduty") {
      return await sendPagerDuty({
        credentials: credentials as PagerDutyCredentials,
        serviceId: channel.destination,
        action: params.pagerDutyAction ?? "trigger",
        dedupKey: params.dedupKey,
        summary: rendered.summary,
        details: params.details,
      });
    }
    const outcome = await sendBackupNotification({
      integrationId: channel.integrationId,
      destination: channel.destination,
      organizationId,
      plugin: PLUGIN,
      message: rendered.chat,
    });
    if (outcome.delivered) {
      return DELIVERED;
    }
    return {
      ok: false,
      status: outcome.status,
      retryable: outcome.retryable ?? false,
      message: outcome.error ?? "The message could not be delivered.",
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      message: `Could not deliver: ${getErrorMessage(error)}`,
    };
  }
}

async function sendPagerDuty(params: {
  credentials: PagerDutyCredentials;
  serviceId: string;
  action: PagerDutyAction;
  dedupKey?: string;
  summary: string;
  details?: Record<string, unknown>;
}): Promise<DeliveryOutcome> {
  const service = await resolveRoutingKey(params.credentials, params.serviceId);
  if (!service.ok) {
    return {
      ok: false,
      status: service.failure.status,
      retryable: service.failure.retryable,
      retryAfterMs: service.failure.retryAfterMs,
      message: service.failure.message,
    };
  }

  const timestamp = new Date().toISOString();
  const body =
    params.action === "change"
      ? {
          routing_key: service.value.routingKey,
          payload: {
            summary: params.summary,
            timestamp,
            source: "keeperhub",
            custom_details: params.details ?? {},
          },
        }
      : {
          routing_key: service.value.routingKey,
          event_action: params.action,
          dedup_key: params.dedupKey,
          ...(params.action === "trigger"
            ? {
                payload: {
                  summary: params.summary,
                  source: "keeperhub",
                  severity: "error",
                  timestamp,
                  custom_details: params.details ?? {},
                },
              }
            : {}),
        };

  const result = await postEvent(
    params.credentials,
    body,
    params.action === "change" ? "/v2/change/enqueue" : "/v2/enqueue"
  );
  if (result.ok) {
    return DELIVERED;
  }
  return {
    ok: false,
    status: result.failure.status,
    retryable: result.failure.retryable,
    retryAfterMs: result.failure.retryAfterMs,
    message: result.failure.message,
  };
}

/**
 * Check a channel still works without sending anything anyone would see.
 *
 * Discord: read the webhook. Telegram: read the chat. Slack: check the token.
 * PagerDuty: read the service and its Events API key. None of these post a
 * message, page anyone or leave a mark on a timeline.
 */
export async function checkChannelSilently(
  channel: ChannelConfig,
  organizationId: string
): Promise<DeliveryOutcome> {
  try {
    const credentials = await orgCredentials(channel, organizationId);
    if (!credentials) {
      return UNUSABLE_CONNECTION;
    }
    switch (channel.kind) {
      case "discord":
        return await checkDiscord(credentials.webhookUrl ?? "");
      case "telegram":
        return await checkGet(
          telegramGetChatUrl(
            credentials.TELEGRAM_BOT_TOKEN ?? "",
            channel.destination
          ),
          "Telegram"
        );
      case "slack":
        return await checkSlack(credentials.SLACK_API_KEY ?? "");
      default: {
        const service = await resolveRoutingKey(
          credentials as PagerDutyCredentials,
          channel.destination
        );
        return service.ok
          ? DELIVERED
          : {
              ok: false,
              status: service.failure.status,
              retryable: service.failure.retryable,
              message: service.failure.message,
            };
      }
    }
  } catch (error) {
    return {
      ok: false,
      retryable: !(error instanceof SsrfBlockedError),
      message: `Could not check the channel: ${getErrorMessage(error)}`,
    };
  }
}

async function checkDiscord(webhookUrl: string): Promise<DeliveryOutcome> {
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    return {
      ok: false,
      retryable: false,
      message: "The Discord connection does not hold a Discord webhook URL.",
    };
  }
  return await checkGet(webhookUrl, "Discord");
}

async function checkGet(url: string, name: string): Promise<DeliveryOutcome> {
  const response = await safeFetch(url, {
    plugin: PLUGIN,
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    return DELIVERED;
  }
  return {
    ok: false,
    status: response.status,
    retryable: isRetryableHttpStatus(response.status),
    message: `${name} returned HTTP ${response.status}.`,
  };
}

async function checkSlack(token: string): Promise<DeliveryOutcome> {
  const response = await safeFetch(SLACK_AUTH_TEST_URL, {
    plugin: PLUGIN,
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (response.ok && body.ok) {
    return DELIVERED;
  }
  return {
    ok: false,
    status: response.status,
    retryable: response.ok
      ? body.error === "ratelimited"
      : isRetryableHttpStatus(response.status),
    message: body.error ?? `Slack returned HTTP ${response.status}.`,
  };
}
