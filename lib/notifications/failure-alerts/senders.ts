import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { sendEmailDetailed } from "@/lib/email";
import {
  sendBackupNotification,
  slackFailureIsRetryable,
} from "@/lib/notifications/backup-channel";
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
  buildTriggerEvent,
  CHANGE_EVENT_PATH,
  MAX_SUMMARY_CHARS,
  postEvent,
  resolveRoutingKey,
  serviceSwallowsEvents,
  truncateRunes,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import type { RenderedMessage } from "./messages";
import type { ChannelConfig } from "./policy";

/** One delivery attempt's outcome; senders never throw. */
export type DeliveryOutcome = {
  ok: boolean;
  status?: number;
  /** Worth another attempt: a timeout, a rate limit, a 5xx. */
  retryable: boolean;
  retryAfterMs?: number;
  /** Ours to fix (our email key), so our on-call hears about it. */
  platformFault?: boolean;
  /** Not delivered but the channel is fine (maintenance window): back up, do not pause. */
  channelHealthy?: boolean;
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

const PLAIN_ERRORS: Record<string, Record<number, string>> = {
  telegram: {
    400: "Telegram could not find that chat. Check the chat ID, and that the bot was added to it",
    401: "Telegram rejected the bot token. Reconnect the bot in Connections",
    403: "The bot was removed from the chat or blocked. Add it back",
    404: "Telegram rejected the bot token. Reconnect the bot in Connections",
  },
  discord: {
    401: "Discord rejected this webhook. Create a new one and update the connection",
    404: "This Discord webhook was deleted. Create a new one and update the connection",
  },
  pagerduty: {
    400: "PagerDuty rejected the event. Check the service still has an Events API v2 integration",
    401: "PagerDuty rejected the credentials. Reconnect PagerDuty in Connections",
    403: "These PagerDuty credentials may not read the service. Check their permissions",
    404: "The PagerDuty service no longer exists or cannot be seen with these credentials",
  },
};

const SLACK_ERRORS: Record<string, string> = {
  channel_not_found:
    "Slack could not find that channel. Check the name, and invite the KeeperHub app to it",
  not_in_channel: "The KeeperHub app is not in that channel. Invite it",
  is_archived: "That Slack channel is archived",
  invalid_auth: "Slack rejected the token. Reconnect Slack in Connections",
  account_inactive:
    "The Slack token was revoked. Reconnect Slack in Connections",
  token_revoked: "The Slack token was revoked. Reconnect Slack in Connections",
};

/** Explain a provider refusal, keeping the code at the end for lookup. */
export function explainFailure(
  kind: string,
  status: number | undefined,
  raw: string
): string {
  if (kind === "slack") {
    const plain = SLACK_ERRORS[raw];
    return plain ? `${plain} (${raw}).` : raw;
  }
  const plain = status ? PLAIN_ERRORS[kind]?.[status] : undefined;
  return plain ? `${plain} (HTTP ${status}).` : raw;
}

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

const CHAT_KINDS: ReadonlySet<string> = new Set([
  "slack",
  "discord",
  "telegram",
]);

/** A method kind this code does not know: refuse it rather than guess. */
function unknownKind(kind: never | string): DeliveryOutcome {
  return {
    ok: false,
    retryable: false,
    message: `KeeperHub cannot send to a ${kind} method yet.`,
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

type PagerDutyAction = "trigger" | "resolve" | "change";

export async function sendChannelMessage(params: {
  channel: ChannelConfig;
  organizationId: string;
  rendered: RenderedMessage;
  /** PagerDuty only: one incident per failing streak, kept across retries. */
  dedupKey?: string;
  pagerDutyAction?: PagerDutyAction;
  details?: Record<string, unknown>;
  /** PagerDuty only: where the incident links back to. */
  link?: string;
  /** PagerDuty only: alerts sharing a group can be merged into one incident. */
  pagerDutyGroup?: string;
  pagerDutySeverity?: "error" | "warning";
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
        link: params.link,
        group: params.pagerDutyGroup,
        severity: params.pagerDutySeverity,
      });
    }
    if (!CHAT_KINDS.has(channel.kind)) {
      return unknownKind(channel.kind);
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
      message: explainFailure(
        channel.kind,
        outcome.status,
        outcome.error ?? "The message could not be delivered."
      ),
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      message: `Could not deliver: ${getErrorMessage(error)}`,
    };
  }
}

/** Reuses the PagerDuty node's event builder so pages match a workflow's own. */
async function sendPagerDuty(params: {
  credentials: PagerDutyCredentials;
  serviceId: string;
  action: PagerDutyAction;
  dedupKey?: string;
  summary: string;
  details?: Record<string, unknown>;
  link?: string;
  group?: string;
  severity?: "error" | "warning";
}): Promise<DeliveryOutcome> {
  const service = await resolveRoutingKey(params.credentials, params.serviceId);
  if (!service.ok) {
    return {
      ok: false,
      status: service.failure.status,
      retryable: service.failure.retryable,
      retryAfterMs: service.failure.retryAfterMs,
      message: explainFailure(
        "pagerduty",
        service.failure.status,
        service.failure.message
      ),
    };
  }
  // Maintenance or disabled services page nobody: fire backups, keep the channel.
  if (
    params.action === "trigger" &&
    serviceSwallowsEvents(service.value.serviceStatus)
  ) {
    return {
      ok: false,
      retryable: false,
      channelHealthy: true,
      message: `The PagerDuty service is ${service.value.serviceStatus}, so nobody was paged.`,
    };
  }

  const timestamp = new Date().toISOString();
  let body: Record<string, unknown>;
  if (params.action === "change") {
    body = {
      routing_key: service.value.routingKey,
      payload: {
        summary: truncateRunes(params.summary, MAX_SUMMARY_CHARS),
        timestamp,
        source: "keeperhub",
        custom_details: params.details ?? {},
      },
    };
  } else if (params.action === "resolve") {
    body = {
      routing_key: service.value.routingKey,
      event_action: "resolve",
      dedup_key: params.dedupKey,
    };
  } else {
    body = buildTriggerEvent({
      routingKey: service.value.routingKey,
      dedupKey: params.dedupKey ?? "",
      timestamp,
      input: {
        summary: params.summary,
        severity: params.severity ?? "error",
        source: "keeperhub",
        group: params.group,
        customDetails: params.details,
        client: "KeeperHub",
        clientUrl: params.link,
      },
    }).body;
  }

  const result = await postEvent(
    params.credentials,
    body,
    params.action === "change" ? CHANGE_EVENT_PATH : "/v2/enqueue"
  );
  if (result.ok) {
    return DELIVERED;
  }
  return {
    ok: false,
    status: result.failure.status,
    retryable: result.failure.retryable,
    retryAfterMs: result.failure.retryAfterMs,
    message: explainFailure(
      "pagerduty",
      result.failure.status,
      result.failure.message
    ),
  };
}

/** Check a channel without posting; plugin tests skip the SSRF guard and give no retry hint. */
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
          "telegram"
        );
      case "slack":
        return await checkSlack(credentials.SLACK_API_KEY ?? "");
      case "pagerduty": {
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
              message: explainFailure(
                "pagerduty",
                service.failure.status,
                service.failure.message
              ),
            };
      }
      default:
        return unknownKind(channel.kind);
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
  return await checkGet(webhookUrl, "discord");
}

async function checkGet(url: string, kind: string): Promise<DeliveryOutcome> {
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
    message: explainFailure(
      kind,
      response.status,
      `The check returned HTTP ${response.status}.`
    ),
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
    retryable: slackFailureIsRetryable(
      response.ok,
      response.status,
      body.error
    ),
    message: explainFailure(
      "slack",
      response.status,
      body.error ?? `Slack returned HTTP ${response.status}.`
    ),
  };
}
