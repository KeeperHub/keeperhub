/**
 * Sanitize unknown thrown values from ethers/RPC call sites for safe logging.
 *
 * Ethers v6 inlines `info.requestUrl` (the full URL, including any embedded
 * API key) into `Error.message`. Catch blocks that log only `error.message`
 * therefore leak the key. This module returns a normalized shape that:
 *
 *   - prefers `error.shortMessage` (which does not contain `requestUrl`
 *     in ethers 6.x)
 *   - falls back to `error.message` after running it through `scrubRpcUrls`
 *   - preserves `error.code` so callers retain retry-decision semantics
 *
 * Mirrors the defensive `Partial<EthersError>` + key-check idiom used in
 * `lib/rpc/providers/error-classification.ts`. See `lib/utils/redact.ts`
 * for the orthogonal field-name redaction utility (different threat model
 * - structured object input, not error-string output).
 */

import type { EthersError } from "ethers";
import { scrubRpcUrls } from "./scrub-rpc-urls";

export type SanitizedRpcError = {
  message: string;
  code?: string;
  shortMessage?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  candidate: Record<string, unknown>,
  key: string
): string | undefined {
  const value = candidate[key];
  return typeof value === "string" ? value : undefined;
}

export function sanitizeRpcError(error: unknown): SanitizedRpcError {
  if (error === null || error === undefined) {
    return { message: "Unknown error (no error value)" };
  }

  if (typeof error === "string") {
    return { message: scrubRpcUrls(error) };
  }

  if (!isObject(error)) {
    return { message: scrubRpcUrls(String(error)) };
  }

  // Read fields by name rather than narrowing to a specific EthersError
  // variant - the v6 union discriminates on `code` and not every catch
  // receives a true EthersError instance (intercepted, re-thrown, etc).
  const candidate = error as Partial<EthersError> & Record<string, unknown>;

  const code = readString(candidate, "code");

  const rawShort = readString(candidate, "shortMessage");
  const shortMessage =
    rawShort === undefined ? undefined : scrubRpcUrls(rawShort);

  const rawMessage = readString(candidate, "message");
  const scrubbedMessage =
    rawMessage === undefined ? undefined : scrubRpcUrls(rawMessage);

  // Preference order: shortMessage (cleanest in ethers v6) > scrubbed
  // message > code > constant. Always non-empty.
  const message =
    shortMessage ?? scrubbedMessage ?? code ?? "Unknown RPC error";

  return { message, code, shortMessage };
}

/**
 * Single-string variant for direct use in `console.error(...)` / template
 * literals. Includes the ethers error code in parentheses when present so
 * the log line stays useful for debugging retry behavior.
 */
export function formatSanitizedRpcError(error: unknown): string {
  const { message, code } = sanitizeRpcError(error);
  return code ? `${message} (${code})` : message;
}
