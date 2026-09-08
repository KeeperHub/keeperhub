import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { ClerkCredentials } from "../credentials";
import { type ClerkUserResult, toClerkUserData } from "../types";
import { clerkFetch, requireClerkSecretKey } from "./clerk-core";

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
  const keyResult = requireClerkSecretKey(credentials);
  if ("error" in keyResult) {
    return keyResult;
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

    const result = await clerkFetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(input.userId)}`,
      {
        secretKey: keyResult.secretKey,
        method: "PATCH",
        body: JSON.stringify(body),
        failureMessagePrefix: "Failed to update user",
      }
    );

    if ("error" in result) {
      return result;
    }

    const apiUser = await result.response.json();
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
