import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { eq } from "drizzle-orm";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { safeFetch } from "@/lib/safe-fetch";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { SendGridCredentials } from "../credentials";

const SENDGRID_API_URL = "https://api.sendgrid.com";

type SendGridErrorResponse = {
  errors: Array<{
    message: string;
    field?: string;
    help?: string;
  }>;
};

type SendEmailResult =
  | { success: true; id: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SendEmailCoreInput = {
  emailFrom?: string;
  emailTo: string;
  emailSubject: string;
  emailBody: string;
  emailCc?: string;
  emailBcc?: string;
  emailReplyTo?: string;
};

export type SendEmailInput = StepInput &
  SendEmailCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Email sending requires validation of many fields
async function stepHandler(
  input: SendEmailCoreInput,
  credentials: SendGridCredentials,
  useKeeperHubApiKey: boolean
): Promise<SendEmailResult> {
  // Determine which API key to use
  let apiKey: string | undefined;

  if (useKeeperHubApiKey) {
    // Use KeeperHub API key from environment
    apiKey = process.env.SENDGRID_API_KEY;
  } else {
    // Use user's own API key from credentials
    apiKey = credentials.SENDGRID_API_KEY;
  }

  if (!apiKey) {
    return {
      success: false,
      error: useKeeperHubApiKey
        ? "SENDGRID_API_KEY is not configured in environment variables."
        : "SENDGRID_API_KEY is not configured. Please add it in Project Integrations.",
      errorClass: useKeeperHubApiKey ? ExecutionErrorType.SYSTEM : ExecutionErrorType.USER,
    };
  }

  // Use FROM_ADDRESS from environment variables, fallback to default
  const fromAddress = process.env.FROM_ADDRESS || "noreply@keeperhub.com";

  try {
    const personalizations = [
      {
        to: [{ email: input.emailTo }],
        ...(input.emailCc && {
          cc: input.emailCc
            .split(",")
            .map((email) => ({ email: email.trim() })),
        }),
        ...(input.emailBcc && {
          bcc: input.emailBcc
            .split(",")
            .map((email) => ({ email: email.trim() })),
        }),
        subject: input.emailSubject,
      },
    ];

    const emailData = {
      personalizations,
      from: { email: fromAddress },
      content: [
        {
          type: "text/plain",
          value: input.emailBody,
        },
      ],
      ...(input.emailReplyTo && { reply_to: { email: input.emailReplyTo } }),
    };

    const response = await safeFetch(`${SENDGRID_API_URL}/v3/mail/send`, {
      plugin: "sendgrid",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailData),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as SendGridErrorResponse;
      const errorMessage =
        errorData.errors && errorData.errors.length > 0
          ? errorData.errors.map((e) => e.message).join(", ")
          : `HTTP ${response.status}: Failed to send email`;
      return {
        success: false,
        error: errorMessage,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    // SendGrid doesn't return a message ID in the response, so we generate one
    const messageId = `sg-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    return { success: true, id: messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to send email: ${message}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * Check if execution belongs to an anonymous workflow
 */
async function isAnonymousExecution(executionId?: string): Promise<boolean> {
  if (!executionId) {
    return false;
  }

  const execution = await db
    .select({ isAnonymous: workflows.isAnonymous })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.isAnonymous ?? false;
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendEmailStep(
  input: SendEmailInput
): Promise<SendEmailResult> {
  "use step";

  // Block anonymous users from sending emails
  if (await isAnonymousExecution(input._context?.executionId)) {
    return {
      success: false,
      error: "Please sign in to send emails.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  // Always use KeeperHub API key
  const useKeeperHubApiKey = true;

  const coreInput: SendEmailCoreInput = {
    ...input,
  };

  return runPluginStep(
    { pluginName: "sendgrid", actionName: "send-email" },
    input,
    () => stepHandler(coreInput, credentials, useKeeperHubApiKey)
  );
}
sendEmailStep.maxRetries = 0;

// Export marker for codegen auto-generation
export const _integrationType = "sendgrid";
