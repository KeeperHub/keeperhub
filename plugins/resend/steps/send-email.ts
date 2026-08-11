import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import type { ResendCredentials } from "../credentials";

const RESEND_API_URL = "https://api.resend.com";

type ResendEmailResponse = {
  id: string;
};

type ResendErrorResponse = {
  statusCode: number;
  message: string;
  name: string;
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
  emailScheduledAt?: string;
  emailTopicId?: string;
  idempotencyKey?: string;
};

export type SendEmailInput = StepInput &
  SendEmailCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendEmailCoreInput,
  credentials: ResendCredentials
): Promise<SendEmailResult> {
  const apiKey = credentials.RESEND_API_KEY;
  const fromEmail = credentials.RESEND_FROM_EMAIL;

  if (!apiKey) {
    return {
      success: false,
      error:
        "RESEND_API_KEY is not configured. Please add it in Project Integrations.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const senderEmail = input.emailFrom || fromEmail;

  if (!senderEmail) {
    return {
      success: false,
      error:
        "No sender is configured. Please add it in the action or in Project Integrations.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    if (input.idempotencyKey) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    const response = await safeFetch(`${RESEND_API_URL}/emails`, {
      plugin: "resend",
      method: "POST",
      headers,
      body: JSON.stringify({
        from: senderEmail,
        to: input.emailTo,
        subject: input.emailSubject,
        text: input.emailBody,
        ...(input.emailCc && { cc: input.emailCc }),
        ...(input.emailBcc && { bcc: input.emailBcc }),
        ...(input.emailReplyTo && { reply_to: input.emailReplyTo }),
        ...(input.emailScheduledAt && { scheduled_at: input.emailScheduledAt }),
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as ResendErrorResponse;
      return {
        success: false,
        error: errorData.message || `HTTP ${response.status}: Failed to send email`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const data = (await response.json()) as ResendEmailResponse;
    return { success: true, id: data.id };
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
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendEmailStep(
  input: SendEmailInput
): Promise<SendEmailResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  const coreInput: SendEmailCoreInput = {
    ...input,
    idempotencyKey: input._context?.executionId,
  };

  return withStepLogging(input, () => stepHandler(coreInput, credentials));
}
sendEmailStep.maxRetries = 0;

// Export marker for codegen auto-generation
export const _integrationType = "resend";
