/**
 * Structured error envelope for REST API responses.
 *
 * KEEP-489: errors across REST + MCP have historically returned bare prose
 * strings ("Unauthorized", "Invalid input"). Builders branch on regex
 * matches against the message and break every time copy is updated.
 * Multiple hackathon teams independently reported this; AgentMesh, Aaether,
 * and ComputePool all reverse-engineered defensive parsers.
 *
 * The fix is to ship a stable envelope:
 *
 *   {
 *     "error": "wallet_not_configured",   // machine-readable snake_case
 *     "detail": "No wallet provisioned for chain 8453 in org X",
 *     "hint": "POST /api/integrations/wallet to provision",
 *     "docs": "https://docs.keeperhub.com/...",   // optional
 *     "request_id": "req_..."                     // correlation id
 *   }
 *
 * Callers branch on `error` (the stable code), surface `detail` for
 * debugging, and show `hint` to the developer. `docs` is optional; clients
 * MUST tolerate its absence. `request_id` is always emitted (resolved from
 * the `x-request-id` request header or a fresh UUID) so support and log
 * correlation are always possible. The same id is echoed back on the
 * `x-request-id` response header.
 *
 * This module is the canonical helper. The MCP route uses its own JSON-RPC
 * envelope (KEEP-474, `lib/mcp/session-error.ts`) because JSON-RPC has a
 * different wire shape; both share the same `code` / `hint` philosophy.
 */
import { NextResponse } from "next/server";

export type ApiErrorBody = {
  error: string;
  detail: string;
  hint?: string;
  docs?: string;
  request_id?: string;
};

export type ApiErrorOptions = {
  status: number;
  code: string;
  detail: string;
  hint?: string;
  docs?: string;
  requestId?: string;
  headers?: HeadersInit;
  /**
   * Inbound request headers. When provided, `request_id` is auto-resolved
   * from the `x-request-id` header (validated, length-capped) with a
   * `crypto.randomUUID()` fallback. An explicit `requestId` argument still
   * wins — useful for background tasks where there is no HTTP request.
   */
  requestHeaders?: Headers;
};

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_DETAIL_LENGTH = 1024;

// Hoisted to top level so the engine compiles them once. Biome flags
// in-function regex literals as a perf smell.
// biome-ignore lint/suspicious/noControlCharactersInRegex: log-injection guard intentionally rejects control characters in inbound header values
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const NEWLINE_PATTERN = /\r?\n/;

/**
 * Resolve a correlation id from the inbound `x-request-id` header. Falls
 * back to `crypto.randomUUID()` when the header is absent, blank, or fails
 * validation. The cap prevents log-injection via oversized ids.
 */
export function resolveRequestId(headers?: Headers, fallback?: string): string {
  const raw = headers?.get("x-request-id");
  if (raw && typeof raw === "string") {
    const trimmed = raw.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_REQUEST_ID_LENGTH &&
      !CONTROL_CHAR_PATTERN.test(trimmed)
    ) {
      return trimmed;
    }
  }
  if (fallback && fallback.length > 0) {
    return fallback;
  }
  return crypto.randomUUID();
}

// Patterns that look like absolute filesystem paths or stack-trace frames.
// Stripped in production to keep internal layout out of client-facing
// errors. Defence-in-depth — callers SHOULD still avoid leaking these.
const STACK_FRAME_PATTERN = /^\s+at\s/m;
const PATH_HINTS: RegExp[] = [
  /\/Users\//,
  /\/app\//,
  /\/var\//,
  /\/home\//,
  /\/root\//,
  /[A-Za-z]:\\/,
  /node_modules\//,
  /webpack:\//,
  /\.next\//,
];

/**
 * In production, strip filesystem paths and stack-trace fragments from a
 * detail string before it ships to the client. Truncates to
 * MAX_DETAIL_LENGTH chars regardless of environment. In development and
 * test, the string is passed through (minus the length cap) so authors can
 * see the full context locally.
 */
export function sanitizeDetailForEnv(detail?: string): string | undefined {
  if (detail === undefined || detail === null) {
    return detail ?? undefined;
  }
  let cleaned = detail;
  if (process.env.NODE_ENV === "production") {
    // Truncate at the first stack-frame indicator ("    at Module._compile").
    const stackMatch = cleaned.match(STACK_FRAME_PATTERN);
    if (stackMatch && typeof stackMatch.index === "number") {
      cleaned = cleaned.slice(0, stackMatch.index).trimEnd();
    }
    // Drop lines containing path-like fragments; keep purely human prose.
    const lines = cleaned.split(NEWLINE_PATTERN);
    const kept: string[] = [];
    for (const line of lines) {
      const looksLikePath = PATH_HINTS.some((p) => p.test(line));
      if (!looksLikePath) {
        kept.push(line);
      }
    }
    cleaned = kept.join("\n").trim();
    if (cleaned.length === 0) {
      cleaned = "Internal error (details redacted in production).";
    }
  }
  if (cleaned.length > MAX_DETAIL_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
  }
  return cleaned;
}

/**
 * Build a structured error response. Returns a NextResponse with the
 * envelope as JSON. Callers should prefer this over `NextResponse.json({
 * error: "..." })` so external clients see a consistent shape.
 *
 * `code` MUST be snake_case and stable across releases — clients pin to it.
 * `detail` MAY include human-readable variable substitution (org id,
 * chain id, etc.) but callers SHOULD NOT include secrets, raw error
 * messages from upstream services, or stack traces. In production the
 * helper applies a sanitizer (`sanitizeDetailForEnv`) as defence-in-depth
 * that strips path and stack-frame fragments, but the contract still
 * relies on callers writing safe messages.
 *
 * `request_id` is auto-resolved from the `x-request-id` request header
 * when `requestHeaders` is provided, with a UUID fallback. An explicit
 * `requestId` argument still takes precedence (used by cron / background
 * jobs that lack an HTTP request). The resolved id is echoed back on the
 * response `x-request-id` header so clients can correlate.
 */
export function apiError(options: ApiErrorOptions): NextResponse {
  const requestId =
    options.requestId ?? resolveRequestId(options.requestHeaders);
  const detail = sanitizeDetailForEnv(options.detail) ?? options.detail;

  const body: ApiErrorBody = {
    error: options.code,
    detail,
    request_id: requestId,
  };
  if (options.hint) {
    body.hint = options.hint;
  }
  if (options.docs) {
    body.docs = options.docs;
  }

  // Merge caller headers with the echoed correlation id. Caller wins if
  // they explicitly set `x-request-id`.
  const mergedHeaders = new Headers(options.headers);
  if (!mergedHeaders.has("x-request-id")) {
    mergedHeaders.set("x-request-id", requestId);
  }

  return NextResponse.json(body, {
    status: options.status,
    headers: mergedHeaders,
  });
}

// Canonical codes — keep this list short and reuse aggressively. Per-route
// codes (e.g. WALLET_NOT_CONFIGURED) live next to the route that raises
// them, not here.
export const ApiErrorCodes = {
  UNAUTHORIZED: "unauthorized",
  INSUFFICIENT_SCOPE: "insufficient_scope",
  NOT_FOUND: "not_found",
  INVALID_INPUT: "invalid_input",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  INTERNAL_ERROR: "internal_error",
} as const;

/** One of the documented codes above. */
export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];
