import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import type { DiscordCredentials } from "../credentials";

type DiscordWebhookResponse = {
  id?: string;
  type?: number;
  channel_id?: string;
  message?: string;
  code?: number;
};

type SendDiscordMessageResult =
  | { success: true; messageId: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SendDiscordMessageCoreInput = {
  discordMessage: string;
};

export type SendDiscordMessageInput = StepInput &
  SendDiscordMessageCoreInput & {
    integrationId: string;
  };

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);

/**
 * Validates a Discord webhook URL by hostname over https, not by substring.
 * A substring match on "discord.com/api/webhooks/" is satisfied by an
 * off-host URL that carries it in the path (e.g.
 * https://10.0.0.1/discord.com/api/webhooks/x), which points egress at an
 * internal host. The safeFetch SSRF guard is the network-layer backstop;
 * this rejects an off-host URL before any request is attempted.
 */
function isValidDiscordWebhookUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const hostAllowed =
    DISCORD_WEBHOOK_HOSTS.has(host) ||
    host.endsWith(".discord.com") ||
    host.endsWith(".discordapp.com");
  if (!hostAllowed) {
    return false;
  }
  return parsed.pathname.startsWith("/api/webhooks/");
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendDiscordMessageCoreInput,
  credentials: DiscordCredentials
): Promise<SendDiscordMessageResult> {
  console.log("[Discord] Starting send message step");

  const webhookUrl = credentials.webhookUrl;

  if (!webhookUrl) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[Discord] No webhook URL provided in integration",
      undefined,
      {
        plugin_name: "discord",
        action_name: "send-message",
      }
    );
    return {
      success: false,
      error:
        "Discord webhook URL is required. Please configure it in the integration settings.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Validate webhook URL by hostname (not substring) before egress
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Invalid webhook URL format",
      webhookUrl,
      {
        plugin_name: "discord",
        action_name: "send-message",
      }
    );
    return {
      success: false,
      error: "Invalid Discord webhook URL format",
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    console.log("[Discord] Sending message to webhook");

    const response = await safeFetch(webhookUrl, {
      plugin: "discord",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: input.discordMessage,
      }),
    });

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({}))) as DiscordWebhookResponse;
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Discord] API error:",
        errorData,
        {
          plugin_name: "discord",
          action_name: "send-message",
          service: "discord",
        }
      );
      return {
        success: false,
        error:
          errorData.message ||
          `HTTP ${response.status}: Failed to send Discord message`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    // Discord webhooks return 204 No Content on success or the message object
    const result =
      response.status === 204
        ? null
        : ((await response.json().catch(() => ({}))) as DiscordWebhookResponse);

    console.log("[Discord] Message sent successfully");

    return {
      success: true,
      messageId: result?.id || "sent",
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Discord] Error sending message:",
      error,
      {
        plugin_name: "discord",
        action_name: "send-message",
        service: "discord",
      }
    );
    return {
      success: false,
      error: `Failed to send Discord message: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendDiscordMessageStep(
  input: SendDiscordMessageInput
): Promise<SendDiscordMessageResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null });

  return runPluginStep(
    { pluginName: "discord", actionName: "send-message" },
    input,
    () => stepHandler(input, credentials)
  );
}
sendDiscordMessageStep.maxRetries = 0;

export const _integrationType = "discord";
