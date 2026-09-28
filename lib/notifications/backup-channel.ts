/**
 * Backup notification for an alert that could not be delivered by its primary
 * channel.
 *
 * Lives in lib rather than under plugins/ on purpose: it reads the credentials
 * of whatever connection the user picked as the backup, which by definition
 * belong to another plugin. A file under plugins/<name>/steps/ that reads
 * another plugin's credential keys is exactly what the credential-map coverage
 * test exists to catch, and it is right to catch it - a step reading a key its
 * own plugin never declares is otherwise a typo or a missing form field.
 *
 * The destination is always a stored connection, never a URL typed into a
 * node: every host below is a constant, so a plugin using this keeps its
 * fixed-host egress classification and a workflow cannot point it anywhere
 * new. The channel is inferred from the credentials the connection holds, so
 * swapping the connection needs no second config field kept in sync.
 *
 * Used by the PagerDuty node when a page cannot be delivered. Nothing here is
 * PagerDuty-specific: the caller names itself for egress attribution and
 * writes its own message, because what a failed alert should say is the
 * caller's business, not this file's.
 */
import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  isValidDiscordWebhookUrl,
  SLACK_POST_MESSAGE_URL,
  telegramSendMessageUrl,
} from "@/lib/notifications/messaging-endpoints";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

const REQUEST_TIMEOUT_MS = 10_000;

export type BackupChannel = "discord" | "slack" | "telegram";

export type BackupOutcome = {
  /** False when the node did not ask for a backup, or had nothing to send through. */
  attempted: boolean;
  delivered: boolean;
  channel?: BackupChannel;
  error?: string;
};

type Credentials = Record<string, string | undefined>;

function detectChannel(credentials: Credentials): BackupChannel | null {
  if (credentials.webhookUrl) {
    return "discord";
  }
  if (credentials.SLACK_API_KEY) {
    return "slack";
  }
  if (credentials.TELEGRAM_BOT_TOKEN) {
    return "telegram";
  }
  return null;
}

async function postDiscord(
  credentials: Credentials,
  plugin: string,
  message: string
): Promise<BackupOutcome> {
  const webhookUrl = credentials.webhookUrl ?? "";
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    return {
      attempted: true,
      delivered: false,
      channel: "discord",
      error:
        "The backup Discord connection does not hold a Discord webhook URL.",
    };
  }
  const response = await safeFetch(webhookUrl, {
    plugin,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.ok
    ? { attempted: true, delivered: true, channel: "discord" }
    : {
        attempted: true,
        delivered: false,
        channel: "discord",
        error: `Discord returned HTTP ${response.status}.`,
      };
}

async function postSlack(
  credentials: Credentials,
  plugin: string,
  destination: string,
  message: string
): Promise<BackupOutcome> {
  if (!destination) {
    return {
      attempted: true,
      delivered: false,
      channel: "slack",
      error: "A Slack backup needs a channel, for example #alerts.",
    };
  }
  const response = await safeFetch(SLACK_POST_MESSAGE_URL, {
    plugin,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.SLACK_API_KEY}`,
    },
    body: JSON.stringify({ channel: destination, text: message }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  return response.ok && body.ok
    ? { attempted: true, delivered: true, channel: "slack" }
    : {
        attempted: true,
        delivered: false,
        channel: "slack",
        error: body.error ?? `Slack returned HTTP ${response.status}.`,
      };
}

async function postTelegram(
  credentials: Credentials,
  plugin: string,
  destination: string,
  message: string
): Promise<BackupOutcome> {
  if (!destination) {
    return {
      attempted: true,
      delivered: false,
      channel: "telegram",
      error: "A Telegram backup needs a chat id.",
    };
  }
  const response = await safeFetch(
    telegramSendMessageUrl(credentials.TELEGRAM_BOT_TOKEN ?? ""),
    {
      plugin,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: destination, text: message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  return response.ok
    ? { attempted: true, delivered: true, channel: "telegram" }
    : {
        attempted: true,
        delivered: false,
        channel: "telegram",
        error: `Telegram returned HTTP ${response.status}.`,
      };
}

/**
 * Post the backup message. Never throws: the outcome goes back to the caller
 * to report in its step output, next to the failure that caused it, because
 * the one thing worse than a missed alert is a missed alert whose backup
 * failed silently.
 */
export async function sendBackupNotification(params: {
  integrationId?: string;
  destination?: string;
  organizationId?: string | null;
  /** The plugin asking for the backup, so its egress is attributed to it. */
  plugin: string;
  message: string;
}): Promise<BackupOutcome> {
  if (!params.integrationId) {
    return { attempted: false, delivered: false };
  }

  try {
    const credentials = (await fetchCredentials(params.integrationId, {
      organizationId: params.organizationId ?? null,
    })) as Credentials;

    const channel = detectChannel(credentials);
    const destination = params.destination?.trim() ?? "";

    if (channel === "discord") {
      return await postDiscord(credentials, params.plugin, params.message);
    }
    if (channel === "slack") {
      return await postSlack(
        credentials,
        params.plugin,
        destination,
        params.message
      );
    }
    if (channel === "telegram") {
      return await postTelegram(
        credentials,
        params.plugin,
        destination,
        params.message
      );
    }
    return {
      attempted: true,
      delivered: false,
      error:
        "The backup connection is not a Discord, Slack or Telegram connection, or it no longer exists.",
    };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      error: `Backup notification failed: ${getErrorMessage(error)}`,
    };
  }
}
