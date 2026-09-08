import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { ClerkCredentials } from "../credentials";
import { type ClerkFailure, clerkFetch, requireClerkSecretKey } from "./clerk-core";

type DeleteUserResult = { success: true; data: { deleted: true } } | ClerkFailure;

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
        method: "DELETE",
        failureMessagePrefix: "Failed to delete user",
      }
    );

    if ("error" in result) {
      return result;
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
