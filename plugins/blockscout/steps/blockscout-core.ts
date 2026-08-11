import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import type { BlockscoutCredentials } from "../credentials";
import { BLOCKSCOUT_INSTANCES } from "../chains";

// Default public Blockscout instance (Ethereum mainnet), used when no chain is
// selected and no custom instance URL is configured.
const DEFAULT_BLOCKSCOUT_API_URL = "https://eth.blockscout.com";

// Strips one or more trailing slashes so paths can be appended consistently.
const TRAILING_SLASH_RE = /\/+$/;

export type BlockscoutFetchResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

type InstanceResolution =
  | { url: string }
  | { error: string };

/**
 * Resolve which Blockscout instance to query.
 *
 * Precedence:
 *   1. An explicit connection instance URL (BLOCKSCOUT_API_URL) always wins --
 *      this is the opt-in for self-hosted or rate-limited instances.
 *   2. Otherwise the selected chain's hosted instance.
 *   3. Otherwise the default Ethereum mainnet instance.
 *
 * Returns an error when a chain is selected that has no known hosted instance
 * and no connection override, rather than silently falling back to Ethereum.
 */
export function resolveInstance(
  credentials: BlockscoutCredentials,
  network?: string | number
): InstanceResolution {
  const override = credentials.BLOCKSCOUT_API_URL?.trim();
  if (override) {
    return { url: override.replace(TRAILING_SLASH_RE, "") };
  }

  const hasNetwork =
    network !== undefined && network !== null && String(network).trim() !== "";
  if (hasNetwork) {
    let chainId: number;
    try {
      chainId = getChainIdFromNetwork(network as string | number);
    } catch {
      return { error: `Unrecognized chain "${network}".` };
    }
    const mapped = BLOCKSCOUT_INSTANCES[chainId];
    if (mapped) {
      return { url: mapped };
    }
    return {
      error: `No hosted Blockscout instance is configured for chain ${chainId}. Add a Blockscout connection with that chain's instance URL.`,
    };
  }

  return { url: DEFAULT_BLOCKSCOUT_API_URL };
}

/**
 * Perform a read-only GET against the Blockscout REST API (v2). Resolves the
 * target instance from the selected chain or connection, appends an optional
 * API key for higher rate limits, and normalizes errors into the
 * discriminated-union result shape used by every step.
 */
export async function blockscoutGet<T>(
  path: string,
  credentials: BlockscoutCredentials,
  network?: string | number
): Promise<BlockscoutFetchResult<T>> {
  const resolved = resolveInstance(credentials, network);
  if ("error" in resolved) {
    return { success: false, error: resolved.error, errorClass: ExecutionErrorType.USER };
  }

  const apiKey = credentials.BLOCKSCOUT_API_KEY?.trim();
  const url = new URL(`${resolved.url}${path}`);
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }

  try {
    // SSRF guard: the instance URL is user-configurable (BLOCKSCOUT_API_URL on
    // the connection), so validate it before any outbound request.
    // `assertUrlIsPublic` is always-on -- it ignores `SAFE_FETCH_SHADOW`/
    // shadow mode -- so an instance URL pointing at an internal address is
    // blocked here even where `safeFetch` would only log-and-continue.
    // Mirrors plugins/webhook/steps/send-webhook.ts.
    await assertUrlIsPublic(url.toString());

    const response = await safeFetch(url.toString(), {
      plugin: "blockscout",
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          error: "Not found on this Blockscout instance.",
          errorClass: ExecutionErrorType.USER,
        };
      }
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        errorClass: response.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    const data = (await response.json()) as T;
    return { success: true, data };
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Blockscout] Blocked SSRF target",
        error.message,
        { plugin_name: "blockscout" }
      );
      return {
        success: false,
        error: `Blockscout instance URL is not allowed: ${error.message}`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    return {
      success: false,
      error: `Failed to reach Blockscout: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}
