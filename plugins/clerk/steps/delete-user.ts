import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { ClerkCredentials } from "../credentials";

type DeleteUserResult =
  | { success: true; data: { deleted: true } }
  | {
      success: false;
      error: { message: string };
      errorClass?: ExecutionErrorType;
    };

export type ClerkDeleteUserCoreInput = {
  userId: string;
};

export type ClerkDeleteUserInput = StepInput &
  ClerkDeleteUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkDeleteUserCoreInput,
  credentials: ClerkCredentials
): Promise<DeleteUserResult> {
  const secretKey = credentials.CLERK_SECRET_KEY;

  if (!secretKey) {
    return {
      success: false,
      error: {
        message:
          "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
      },
      errorClass: ExecutionErrorType.USER,
    };
  }

  if (!input.userId) {
    return {
      success: false,
      error: { message: "User ID is required." },
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    const response = await safeFetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(input.userId)}`,
      {
        plugin: "clerk",
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          "User-Agent": "workflow-builder.dev",
        },
      }
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      return {
        success: false,
        error: {
          message:
            errorBody.errors?.[0]?.message ||
            `Failed to delete user: ${response.status}`,
        },
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    return { success: true, data: { deleted: true } };
  } catch (err) {
    return {
      success: false,
      error: { message: `Failed to delete user: ${getErrorMessage(err)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkDeleteUserStep(
  input: ClerkDeleteUserInput
): Promise<DeleteUserResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkDeleteUserStep.maxRetries = 0;

export const _integrationType = "clerk";
