import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import type { EvmChainCredentials } from "../credentials";

// Read-only JSON-RPC queries should return quickly; a slow or hung endpoint
// must not hold the step open. Same timeout style as plugins/robinhood.
const FETCH_TIMEOUT_MS = 10_000;

const HEX_VALUE_RE = /^0x[0-9a-fA-F]+$/;
const TRAILING_ZEROS_RE = /0+$/;

export type EvmRpcResult =
  | { success: true; result: unknown }
  | { success: false; error: string };

/**
 * Perform a single read-only JSON-RPC call against the user-supplied endpoint.
 *
 * The RPC URL is user input, so it is validated before any egress:
 * assertUrlIsPublic is always-on (it ignores SAFE_FETCH_SHADOW) and rejects
 * private, loopback, and link-local targets before a request is made;
 * safeFetch re-validates on connect, including every redirect hop.
 */
export async function callEvmRpc(
  credentials: EvmChainCredentials,
  method: string,
  params: unknown[] = [],
  id = 1
): Promise<EvmRpcResult> {
  const rpcUrl = credentials.EVM_CHAIN_RPC_URL;
  if (!rpcUrl) {
    return {
      success: false,
      error:
        "EVM_CHAIN_RPC_URL is not configured. Add it in Project Integrations.",
    };
  }

  try {
    await assertUrlIsPublic(rpcUrl);

    const response = await safeFetch(rpcUrl, {
      plugin: "evm-chain",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `RPC endpoint returned HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };

    // Nodes answer HTTP 200 with a JSON-RPC error object (for example an
    // invalid address); surface the node's message instead of the raw body.
    if (payload?.error !== undefined && payload?.error !== null) {
      const message =
        typeof payload.error.message === "string" &&
        payload.error.message.trim() !== ""
          ? payload.error.message
          : JSON.stringify(payload.error);
      const code =
        typeof payload.error.code === "number" ? ` ${payload.error.code}` : "";
      return { success: false, error: `RPC error${code}: ${message}` };
    }

    return { success: true, result: payload?.result };
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[EvmChain] Blocked SSRF target",
        error.message,
        { plugin_name: "evm-chain" }
      );
      return {
        success: false,
        error: `JSON-RPC URL is not allowed: ${error.message}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * True when the value is a 0x-prefixed hex string (JSON-RPC hex results).
 */
export function isHexResult(value: unknown): value is string {
  return typeof value === "string" && HEX_VALUE_RE.test(value);
}

/**
 * Convert a hex wei amount to a decimal string in native units (18
 * decimals). Whole-number balances omit the decimal point; fractions keep
 * only significant digits (no trailing zeros).
 */
export function toNative(hexWei: string): string {
  const wei = BigInt(hexWei);
  const units = wei / BigInt(10) ** BigInt(18);
  const frac = wei % BigInt(10) ** BigInt(18);
  if (frac === BigInt(0)) {
    return units.toString();
  }
  const fracStr = frac.toString().padStart(18, "0").replace(TRAILING_ZEROS_RE, "");
  return `${units.toString()}.${fracStr}`;
}
