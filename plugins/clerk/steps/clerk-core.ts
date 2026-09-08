import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { safeFetch, type SafeFetchOptions } from "@/lib/safe-fetch";
import type { ClerkCredentials } from "../credentials";

export type ClerkFailure = {
  success: false;
  error: { message: string };
  errorClass?: ExecutionErrorType;
};

/**
 * Validate that the Clerk secret key is configured, returning it or the
 * standard configuration failure.
 */
export function requireClerkSecretKey(
  credentials: ClerkCredentials
): { secretKey: string } | ClerkFailure {
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

  return { secretKey };
}

export type ClerkFetchOptions = {
  secretKey: string;
  method?: "POST" | "PATCH" | "DELETE";
  body?: string;
  /** Fallback error prefix when the API body has no message, e.g. "Failed to create user". */
  failureMessagePrefix: string;
};

/**
 * Perform a Bearer-authenticated request against the Clerk API, normalizing
 * HTTP error responses into the errors[0].message failure shape used by every
 * step. Network errors are thrown for the caller's catch block, matching the
 * per-step error messages.
 */
export async function clerkFetch(
  url: string,
  options: ClerkFetchOptions
): Promise<{ response: Response } | ClerkFailure> {
  const init: SafeFetchOptions = {
    plugin: "clerk",
    headers: {
      Authorization: `Bearer ${options.secretKey}`,
      "Content-Type": "application/json",
      "User-Agent": "workflow-builder.dev",
    },
  };
  if (options.method) {
    init.method = options.method;
  }
  if (options.body !== undefined) {
    init.body = options.body;
  }

  const response = await safeFetch(url, init);

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as {
      errors?: Array<{ message?: string }>;
    };
    return {
      success: false,
      error: {
        message:
          errorBody.errors?.[0]?.message ||
          `${options.failureMessagePrefix}: ${response.status}`,
      },
      errorClass:
        response.status >= 500
          ? ExecutionErrorType.EXTERNAL
          : ExecutionErrorType.USER,
    };
  }

  return { response };
}
