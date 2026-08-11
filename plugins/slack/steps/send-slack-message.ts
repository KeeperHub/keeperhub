import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { SlackCredentials } from "../credentials";

const SLACK_API_URL = "https://slack.com/api";

type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
};

type SendSlackMessageResult =
  | { success: true; ts: string; channel: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SendSlackMessageCoreInput = {
  slackChannel: string;
  slackMessage: string;
};

export type SendSlackMessageInput = StepInput &
  SendSlackMessageCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendSlackMessageCoreInput,
  credentials: SlackCredentials
): Promise<SendSlackMessageResult> {
  const apiKey = credentials.SLACK_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error:
        "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    const response = await safeFetch(`${SLACK_API_URL}/chat.postMessage`, {
      plugin: "slack",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        channel: input.slackChannel,
        text: input.slackMessage,
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: Failed to send Slack message`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const result = (await response.json()) as SlackPostMessageResponse;

    if (!result.ok) {
      return {
        success: false,
        error: result.error || "Failed to send Slack message",
        errorClass: ExecutionErrorType.USER,
      };
    }

    return {
      success: true,
      ts: result.ts || "",
      channel: result.channel || "",
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to send Slack message: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendSlackMessageStep(
  input: SendSlackMessageInput
): Promise<SendSlackMessageResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
sendSlackMessageStep.maxRetries = 0;

export const _integrationType = "slack";
