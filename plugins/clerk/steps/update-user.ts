import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { ClerkCredentials } from "../credentials";
import { type ClerkUserResult, toClerkUserData } from "../types";

export type ClerkUpdateUserCoreInput = {
  userId: string;
  firstName?: string;
  lastName?: string;
  publicMetadata?: string;
  privateMetadata?: string;
};

export type ClerkUpdateUserInput = StepInput &
  ClerkUpdateUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkUpdateUserCoreInput,
  credentials: ClerkCredentials
): Promise<ClerkUserResult> {
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
    // Build the request body
    const body: Record<string, unknown> = {};

    if (input.firstName !== undefined) {
      body.first_name = input.firstName;
    }
    if (input.lastName !== undefined) {
      body.last_name = input.lastName;
    }
    if (input.publicMetadata) {
      try {
        body.public_metadata = JSON.parse(input.publicMetadata);
      } catch {
        return {
          success: false,
          error: { message: "Invalid JSON format for publicMetadata" },
          errorClass: ExecutionErrorType.USER,
        };
      }
    }
    if (input.privateMetadata) {
      try {
        body.private_metadata = JSON.parse(input.privateMetadata);
      } catch {
        return {
          success: false,
          error: { message: "Invalid JSON format for privateMetadata" },
          errorClass: ExecutionErrorType.USER,
        };
      }
    }

    const response = await safeFetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(input.userId)}`,
      {
        plugin: "clerk",
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          "User-Agent": "workflow-builder.dev",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      return {
        success: false,
        error: {
          message:
            errorBody.errors?.[0]?.message ||
            `Failed to update user: ${response.status}`,
        },
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const apiUser = await response.json();
    return { success: true, data: toClerkUserData(apiUser) };
  } catch (err) {
    return {
      success: false,
      error: { message: `Failed to update user: ${getErrorMessage(err)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkUpdateUserStep(
  input: ClerkUpdateUserInput
): Promise<ClerkUserResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkUpdateUserStep.maxRetries = 0;

export const _integrationType = "clerk";
