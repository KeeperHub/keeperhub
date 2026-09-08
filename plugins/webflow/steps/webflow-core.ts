import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { safeFetch, type SafeFetchOptions } from "@/lib/safe-fetch";
import type { WebflowCredentials } from "../credentials";

export const WEBFLOW_API_URL = "https://api.webflow.com/v2";

export type WebflowFailure = {
  success: false;
  error: { message: string };
  errorClass?: ExecutionErrorType;
};

/**
 * Validate that the Webflow API key is configured, returning it or the
 * standard configuration failure.
 */
export function requireWebflowApiKey(
  credentials: WebflowCredentials
): { apiKey: string } | WebflowFailure {
  const apiKey = credentials.WEBFLOW_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: {
        message:
          "WEBFLOW_API_KEY is not configured. Please add it in Project Integrations.",
      },
      errorClass: ExecutionErrorType.USER,
    };
  }

  return { apiKey };
}

export type WebflowFetchOptions = {
  apiKey: string;
  method: "GET" | "POST";
  body?: string;
};

/**
 * Perform a Bearer-authenticated request against the Webflow API, normalizing
 * HTTP error responses into the failure shape used by every step. Network
 * errors (and non-JSON error bodies) are thrown for the caller's catch block,
 * matching the per-step error messages.
 */
export async function webflowFetch(
  url: string,
  options: WebflowFetchOptions
): Promise<{ response: Response } | WebflowFailure> {
  const init: SafeFetchOptions = {
    plugin: "webflow",
    method: options.method,
    headers:
      options.body === undefined
        ? {
            Accept: "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          }
        : {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
  };
  if (options.body !== undefined) {
    init.body = options.body;
  }

  const response = await safeFetch(url, init);

  if (!response.ok) {
    const errorData = (await response.json()) as { message?: string };
    return {
      success: false,
      error: { message: errorData.message || `HTTP ${response.status}` },
      errorClass:
        response.status >= 500
          ? ExecutionErrorType.EXTERNAL
          : ExecutionErrorType.USER,
    };
  }

  return { response };
}
