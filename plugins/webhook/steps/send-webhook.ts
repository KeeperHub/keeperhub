import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { assertUrlIsPublic, safeFetch, SsrfBlockedError } from "@/lib/safe-fetch";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

type SendWebhookResult =
  | { success: true; statusCode: number; response: unknown }
  | { success: false; error: string };

export type SendWebhookCoreInput = {
  webhookUrl: string;
  webhookMethod: string;
  webhookHeaders?: string;
  webhookPayload?: string;
};

export type SendWebhookInput = StepInput & SendWebhookCoreInput;

/**
 * Parse JSON string safely, returning null if invalid
 */
function parseJsonSafely(jsonString: string | undefined): unknown {
  if (!jsonString || jsonString.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Webhook] Failed to parse JSON:",
      error,
      {
        plugin_name: "webhook",
        action_name: "send-webhook",
      }
    );
    return null;
  }
}

/**
 * Core logic - portable between app and export
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Webhook handling requires validation of URL, headers, body
async function stepHandler(
  input: SendWebhookCoreInput
): Promise<SendWebhookResult> {
  console.log("[Webhook] Starting send webhook step");

  const url = input.webhookUrl;
  const method = input.webhookMethod || "POST";

  if (!url) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[Webhook] No URL provided",
      undefined,
      {
        plugin_name: "webhook",
        action_name: "send-webhook",
      }
    );
    return {
      success: false,
      error: "Webhook URL is required",
    };
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Webhook] Invalid URL format",
      url,
      {
        plugin_name: "webhook",
        action_name: "send-webhook",
      }
    );
    return {
      success: false,
      error: "Invalid webhook URL format",
    };
  }

  // Parse headers
  const headersObj = parseJsonSafely(input.webhookHeaders);
  const headers: Record<string, string> = {};

  if (
    headersObj &&
    typeof headersObj === "object" &&
    !Array.isArray(headersObj)
  ) {
    for (const [key, value] of Object.entries(headersObj)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
  }

  // Set default Content-Type if not provided and method requires body
  if (
    !(headers["Content-Type"] || headers["content-type"]) &&
    method !== "GET" &&
    input.webhookPayload
  ) {
    headers["Content-Type"] = "application/json";
  }

  // Parse payload
  const payload = parseJsonSafely(input.webhookPayload);

  // SSRF guard: reject private/loopback/link-local/metadata destinations
  // before any outbound request. `assertUrlIsPublic` is always-on -- it
  // ignores `SAFE_FETCH_SHADOW`/shadow mode -- so an attacker-supplied
  // webhookUrl pointing at an internal address (e.g.
  // http://169.254.169.254/latest/meta-data/) is blocked here even in
  // environments where `safeFetch` itself would only log-and-continue.
  try {
    await assertUrlIsPublic(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Webhook] Blocked SSRF target",
        error.message,
        {
          plugin_name: "webhook",
          action_name: "send-webhook",
        }
      );
      return {
        success: false,
        error: `Webhook URL is not allowed: ${error.message}`,
      };
    }
    logUserError(
      ErrorCategory.VALIDATION,
      "[Webhook] Could not validate webhook URL",
      error,
      {
        plugin_name: "webhook",
        action_name: "send-webhook",
      }
    );
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Webhook URL is invalid or could not be resolved",
    };
  }

  try {
    console.log("[Webhook] Sending request to webhook");

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    // Only include body for methods that support it
    if (method !== "GET" && payload !== null) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const response = await safeFetch(url, {
      ...fetchOptions,
      plugin: "webhook",
    });

    let responseData: unknown;
    const contentType = response.headers.get("content-type");

    if (contentType?.includes("application/json")) {
      try {
        responseData = await response.json();
      } catch {
        // If JSON parsing fails, try text
        responseData = await response.text();
      }
    } else {
      responseData = await response.text();
    }

    if (!response.ok) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Webhook] API error:",
        { status: response.status, responseData },
        {
          plugin_name: "webhook",
          action_name: "send-webhook",
          service: "webhook",
        }
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${typeof responseData === "string" ? responseData : JSON.stringify(responseData)}`,
      };
    }

    console.log("[Webhook] Webhook sent successfully");

    return {
      success: true,
      statusCode: response.status,
      response: responseData,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Webhook] Error sending webhook:",
      error,
      {
        plugin_name: "webhook",
        action_name: "send-webhook",
        service: "webhook",
      }
    );
    return {
      success: false,
      error: `Failed to send webhook: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * App entry point - wraps with logging
 */
// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function sendWebhookStep(
  input: SendWebhookInput
): Promise<SendWebhookResult> {
  "use step";

  return runPluginStep(
    { pluginName: "webhook", actionName: "send-webhook" },
    input,
    stepHandler
  );
}
sendWebhookStep.maxRetries = 0;

export const _integrationType = "webhook";
