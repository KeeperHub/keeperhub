import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
import { sleep } from "@/lib/sleep";
import { getErrorMessage } from "@/lib/utils";
import {
  isConnectionFailure,
  isRetryableHttpStatus,
  linearBackoffMs,
  parseRetryAfterHeaderMs,
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";
import type { DiscordCredentials } from "../credentials";

type DiscordWebhookResponse = {
  id?: string;
  type?: number;
  channel_id?: string;
  message?: string;
  code?: number;
  /** Seconds to wait before retrying; present on 429 responses. */
  retry_after?: number;
  /** True when the 429 is a global rate limit on the egress IP, not this webhook. */
  global?: boolean;
};

type SendDiscordMessageResult =
  | { success: true; messageId: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SendDiscordMessageCoreInput = {
  discordMessage: string;
  /** Extra attempts after the first; a string when set from the editor. */
  retryAttempts?: number | string;
  /** Base backoff in seconds; a string when set from the editor. */
  retryDelay?: number | string;
};

export type SendDiscordMessageInput = StepInput &
  SendDiscordMessageCoreInput & {
    integrationId: string;
  };

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);

/**
 * Retry policy for transient Discord failures. Parsing, clamping, the
 * retryable status set, the linear backoff and the connection-failure test
 * are shared with the HTTP Request node (lib/workflow/retry-policy.ts); only
 * the limits are local. The workflow engine's own retries stay off for this
 * step (maxRetries = 0 below), so this loop is the only place a webhook post
 * is re-attempted. Retries default to none, so a node only retries when its
 * author opted in.
 *
 * A webhook post is not idempotent and Discord offers no idempotency key, so
 * a retry can deliver a message twice if the first request reached Discord
 * and only the response was lost. The loop therefore retries a thrown error
 * only when it proves the request never left this process (connection
 * refused, unreachable host, DNS failure). A reset, a broken pipe or a timeout
 * is not retried. A blocked SSRF target is a configuration error and is never
 * retried either.
 *
 * A 429 waits for the interval Discord reports. When that interval is longer
 * than MAX_RETRY_AFTER_MS, or the limit is global to the egress IP, the loop
 * stops instead of shortening the wait: retrying inside the window cannot
 * succeed and counts toward the invalid-request budget that gets the shared
 * egress IP banned. Other transient failures back off linearly from the
 * configured delay, uncapped, exactly as the HTTP Request node does.
 */
const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 0, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };
const MAX_RETRY_AFTER_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HTTP_TOO_MANY_REQUESTS = 429;

const LOG_LABELS = {
  plugin_name: "discord",
  action_name: "send-message",
  service: "discord",
};

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
 * One attempt outcome, kept separate from the step result so the retry loop
 * can tell a transient failure from one that will fail identically on the
 * next attempt without re-parsing error strings.
 */
type AttemptOutcome =
  | { kind: "success"; messageId: string }
  | {
      kind: "http-error";
      status: number;
      error: string;
      /** Discord's parsed error body; its numeric `code` tells an unknown webhook from a bad payload. */
      body: DiscordWebhookResponse;
      /** Milliseconds Discord asked us to wait, when it said. */
      retryAfterMs?: number;
      /** True when a 429 is a global limit on the egress IP. */
      global: boolean;
    }
  | {
      kind: "network-error";
      error: string;
      /** True only when the request provably never reached Discord. */
      retryable: boolean;
    }
  | { kind: "fatal"; error: string };

/**
 * Discord reports the rate-limit wait in two places: a `retry_after` body
 * field in seconds (fractional) and a `Retry-After` header in whole seconds.
 * The body is preferred because it carries sub-second precision. Returns
 * undefined when neither is a usable number.
 */
function parseRetryAfterMs(
  response: Response,
  body: DiscordWebhookResponse
): number | undefined {
  if (typeof body.retry_after === "number" && body.retry_after >= 0) {
    return Math.ceil(body.retry_after * 1000);
  }
  return parseRetryAfterHeaderMs(response.headers?.get?.("retry-after"));
}

function classifyThrow(error: unknown): AttemptOutcome {
  // A blocked SSRF target is a configuration error, not a transient miss.
  // Retrying it would re-run the guard and re-record the block on every
  // attempt. Mirrors lib/workflow/nodes/http-request/perform.ts.
  if (error instanceof SsrfBlockedError) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Blocked SSRF target",
      error.message,
      LOG_LABELS
    );
    return {
      kind: "fatal",
      error: `Failed to send Discord message: URL is not allowed: ${error.message}`,
    };
  }
  return {
    kind: "network-error",
    error: `Failed to send Discord message: ${getErrorMessage(error)}`,
    retryable: isConnectionFailure(error),
  };
}

async function attemptSend(
  webhookUrl: string,
  content: string
): Promise<AttemptOutcome> {
  try {
    const response = await safeFetch(webhookUrl, {
      plugin: "discord",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
      // Bounds each attempt so a stalled socket cannot hang the step; the
      // waits between attempts are bounded separately below.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = (await response
        .json()
        .catch(() => ({}))) as DiscordWebhookResponse;
      const rateLimited = response.status === HTTP_TOO_MANY_REQUESTS;
      return {
        kind: "http-error",
        status: response.status,
        error:
          body.message ||
          `HTTP ${response.status}: Failed to send Discord message`,
        body,
        retryAfterMs: rateLimited ? parseRetryAfterMs(response, body) : undefined,
        global: rateLimited && body.global === true,
      };
    }

    // Discord webhooks return 204 No Content on success or the message object
    const result =
      response.status === 204
        ? null
        : ((await response.json().catch(() => ({}))) as DiscordWebhookResponse);

    return { kind: "success", messageId: result?.id || "sent" };
  } catch (error) {
    return classifyThrow(error);
  }
}

/**
 * Whether another attempt can succeed. The retryable statuses are the HTTP
 * Request node's set (408, 425, 429 and the transient 5xx family). A 429 is
 * abandoned when the limit is global or the requested wait exceeds
 * MAX_RETRY_AFTER_MS, because retrying inside the window cannot succeed. A
 * thrown error is retried only when it proves the request never reached
 * Discord. Every other 4xx (bad payload, unknown webhook, forbidden) fails
 * identically on retry and is not retried.
 */
function isRetryable(outcome: AttemptOutcome): boolean {
  switch (outcome.kind) {
    case "network-error":
      return outcome.retryable;
    case "http-error":
      if (!isRetryableHttpStatus(outcome.status)) {
        return false;
      }
      if (outcome.global) {
        return false;
      }
      return (
        outcome.retryAfterMs === undefined ||
        outcome.retryAfterMs <= MAX_RETRY_AFTER_MS
      );
    default:
      return false;
  }
}

/**
 * Wait before the given retry (1-based). A 429 uses Discord's own interval,
 * already checked against MAX_RETRY_AFTER_MS by isRetryable; everything else
 * backs off linearly from the configured base delay.
 */
function retryDelayMs(
  outcome: AttemptOutcome,
  retry: number,
  baseDelayMs: number
): number {
  if (outcome.kind === "http-error" && outcome.retryAfterMs !== undefined) {
    return outcome.retryAfterMs;
  }
  return linearBackoffMs(baseDelayMs, retry);
}

type FailedOutcome = Exclude<AttemptOutcome, { kind: "success" }>;

/** The value handed to the logger: Discord's body when there is one, so its `code` survives. */
function loggedError(outcome: FailedOutcome): unknown {
  return outcome.kind === "http-error" ? outcome.body : outcome.error;
}

function outcomeLabels(outcome: FailedOutcome): Record<string, string> {
  return outcome.kind === "http-error"
    ? { ...LOG_LABELS, status: String(outcome.status) }
    : LOG_LABELS;
}

function toResult(outcome: AttemptOutcome): SendDiscordMessageResult {
  switch (outcome.kind) {
    case "success":
      return { success: true, messageId: outcome.messageId };
    case "fatal":
      return {
        success: false,
        error: outcome.error,
        errorClass: ExecutionErrorType.USER,
      };
    case "network-error":
      return {
        success: false,
        error: outcome.error,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    default: {
      const external =
        isRetryableHttpStatus(outcome.status) || outcome.status >= 500;
      return {
        success: false,
        error: outcome.error,
        errorClass: external
          ? ExecutionErrorType.EXTERNAL
          : ExecutionErrorType.USER,
      };
    }
  }
}

/**
 * Posts the message, retrying per the policy above. Every failed attempt
 * that is followed by a retry is logged and counted on its own, so a run that
 * recovers after several 5xx responses still reports the failure rate the
 * loop absorbed; the terminal outcome is logged separately by the caller.
 */
async function sendWithRetries(
  webhookUrl: string,
  input: SendDiscordMessageCoreInput
): Promise<AttemptOutcome> {
  const maxRetries = resolveRetryAttempts(
    input.retryAttempts,
    RETRY_ATTEMPT_LIMITS
  );
  const baseDelayMs = resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS);

  let outcome = await attemptSend(webhookUrl, input.discordMessage);
  for (let retry = 1; retry <= maxRetries; retry++) {
    if (outcome.kind === "success" || !isRetryable(outcome)) {
      break;
    }
    const delayMs = retryDelayMs(outcome, retry, baseDelayMs);
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Discord] Attempt failed, retrying",
      loggedError(outcome),
      {
        ...outcomeLabels(outcome),
        attempt: String(retry),
        max_retries: String(maxRetries),
        retry_in_ms: String(delayMs),
      }
    );
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    outcome = await attemptSend(webhookUrl, input.discordMessage);
  }
  return outcome;
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

  console.log("[Discord] Sending message to webhook");

  const outcome = await sendWithRetries(webhookUrl, input);

  if (outcome.kind === "success") {
    console.log("[Discord] Message sent successfully");
    return toResult(outcome);
  }

  if (outcome.kind !== "fatal") {
    // A fatal outcome was already logged where it was classified.
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      outcome.kind === "http-error"
        ? "[Discord] API error:"
        : "[Discord] Error sending message:",
      loggedError(outcome),
      outcomeLabels(outcome)
    );
  }
  return toResult(outcome);
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
