import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { ClerkCredentials } from "../credentials";
import { type ClerkUserResult, toClerkUserData } from "../types";
import { clerkFetch, requireClerkSecretKey } from "./clerk-core";

export type ClerkGetUserCoreInput = {
  userId: string;
};

export type ClerkGetUserInput = StepInput &
  ClerkGetUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkGetUserCoreInput,
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
    const result = await clerkFetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(input.userId)}`,
      {
        secretKey: keyResult.secretKey,
        failureMessagePrefix: "Failed to get user",
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
      error: { message: `Failed to get user: ${getErrorMessage(err)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkGetUserStep(
  input: ClerkGetUserInput
): Promise<ClerkUserResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkGetUserStep.maxRetries = 0;

export const _integrationType = "clerk";
