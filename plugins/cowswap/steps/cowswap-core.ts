import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { safeFetch, type SafeFetchOptions } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

const PLUGIN_NAME = "cowswap";
const FETCH_TIMEOUT_MS = 15_000;

export const COW_API_CHAIN_PATHS: Record<number, string> = {
  1: "mainnet",
  8453: "base",
  42161: "arbitrum_one",
  10: "optimism",
};

export type CowSwapFailure = {
  success: false;
  error: string;
  errorClass?: ExecutionErrorType;
};

/**
 * Resolve the CoW Swap API path segment for a network, validating that the
 * network is recognized and supported by the CoW Swap API.
 */
export function resolveCowChainPath(
  network: string,
  actionName: string
): { chainPath: string } | CowSwapFailure {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Unsupported network",
      network,
      { plugin_name: PLUGIN_NAME, action_name: actionName }
    );
    return {
      success: false,
      error: `Unsupported network: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const chainPath = COW_API_CHAIN_PATHS[chainId];
  if (!chainPath) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[CoW Swap] Network not supported by CoW Swap API",
      { chainId, network },
      { plugin_name: PLUGIN_NAME, action_name: actionName }
    );
    return {
      success: false,
      error: `Chain ID ${chainId} is not supported by the CoW Swap API`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  return { chainPath };
}

export type CowFetchOptions = {
  actionName: string;
  method?: "POST" | "DELETE";
  body?: string;
};

/**
 * Perform a request against the CoW Swap API with the standard 15s timeout,
 * normalizing HTTP error responses into the failure shape used by every step.
 * Network errors and aborts are thrown for the caller's catch block, matching
 * the per-step error logging and messages.
 */
export async function cowFetch(
  url: string,
  options: CowFetchOptions
): Promise<{ response: Response } | CowSwapFailure> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const init: SafeFetchOptions = {
    plugin: "cowswap",
    headers:
      options.body === undefined
        ? { Accept: "application/json" }
        : { "Content-Type": "application/json", Accept: "application/json" },
    signal: controller.signal,
  };
  if (options.method) {
    init.method = options.method;
  }
  if (options.body !== undefined) {
    init.body = options.body;
  }

  const response = await safeFetch(url, init);

  clearTimeout(timeout);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      `[CoW Swap] API error on ${options.actionName}`,
      { status: response.status, body: errorBody },
      {
        plugin_name: PLUGIN_NAME,
        action_name: options.actionName,
        service: "cow-api",
      }
    );
    return {
      success: false,
      error: `CoW Swap API returned HTTP ${response.status}: ${errorBody}`,
      errorClass:
        response.status >= 500
          ? ExecutionErrorType.EXTERNAL
          : ExecutionErrorType.USER,
    };
  }

  return { response };
}
