import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { ClerkCredentials } from "../credentials";
import { type ClerkUserResult, toClerkUserData } from "../types";
import { clerkFetch, requireClerkSecretKey } from "./clerk-core";

export type ClerkCreateUserCoreInput = {
  emailAddress: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  publicMetadata?: string;
  privateMetadata?: string;
};

export type ClerkCreateUserInput = StepInput &
  ClerkCreateUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkCreateUserCoreInput,
  credentials: ClerkCredentials
): Promise<ClerkUserResult> {
  const keyResult = requireClerkSecretKey(credentials);
  if ("error" in keyResult) {
    return keyResult;
  }

  if (!input.emailAddress) {
    return {
      success: false,
      error: { message: "Email address is required." },
      errorClass: ExecutionErrorType.USER,
    };
  }

  try {
    // Build the request body
    const body: Record<string, unknown> = {
      email_address: [input.emailAddress],
    };

    if (input.firstName) {
      body.first_name = input.firstName;
    }
    if (input.lastName) {
      body.last_name = input.lastName;
    }
    if (input.password) {
      body.password = input.password;
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

    const result = await clerkFetch("https://api.clerk.com/v1/users", {
      secretKey: keyResult.secretKey,
      method: "POST",
      body: JSON.stringify(body),
      failureMessagePrefix: "Failed to create user",
    });

    if ("error" in result) {
      return result;
    }

    const apiUser = await result.response.json();
    return { success: true, data: toClerkUserData(apiUser) };
  } catch (err) {
    return {
      success: false,
      error: { message: `Failed to create user: ${getErrorMessage(err)}` },
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkCreateUserStep(
  input: ClerkCreateUserInput
): Promise<ClerkUserResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkCreateUserStep.maxRetries = 0;

export const _integrationType = "clerk";
