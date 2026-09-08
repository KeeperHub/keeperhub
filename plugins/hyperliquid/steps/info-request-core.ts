import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_PATTERN.test(value);
}

export type InfoResult<T = unknown> =
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export async function postInfo<T = unknown>(
  body: Record<string, unknown>,
  actionName: string
): Promise<InfoResult<T>> {
  try {
    const response = await safeFetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      plugin: "hyperliquid",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Hyperliquid] API error:",
        { status: response.status, body: text },
        {
          plugin_name: "hyperliquid",
          action_name: actionName,
          service: "hyperliquid",
        }
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${text || response.statusText}`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const preview = (await response.text().catch(() => "")).slice(0, 120);
      logUserError(
        ErrorCategory.VALIDATION,
        "[Hyperliquid] Non-JSON 2xx response:",
        { contentType, preview },
        {
          plugin_name: "hyperliquid",
          action_name: actionName,
          service: "hyperliquid",
        }
      );
      return {
        success: false,
        error: `Hyperliquid returned non-JSON content-type "${contentType}"`,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }

    let data: T;
    try {
      data = (await response.json()) as T;
    } catch (parseError: unknown) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Hyperliquid] Failed to parse JSON response:",
        parseError,
        {
          plugin_name: "hyperliquid",
          action_name: actionName,
          service: "hyperliquid",
        }
      );
      return {
        success: false,
        error: `Invalid JSON response from Hyperliquid: ${getErrorMessage(parseError)}`,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }

    return { success: true, data };
  } catch (error: unknown) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Hyperliquid] Network error:",
      error,
      {
        plugin_name: "hyperliquid",
        action_name: actionName,
        service: "hyperliquid",
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}
