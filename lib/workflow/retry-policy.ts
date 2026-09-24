/**
 * Retry policy shared by the nodes that re-attempt transient HTTP failures:
 * the HTTP Request node and the Discord plugin today.
 *
 * Deliberately free of `server-only` and Node imports so it can be used from a
 * plugin step, the HTTP Request worker and, if needed, the editor. Each caller
 * supplies its own limits so a node can pick tighter bounds (the Discord step
 * caps the delay at 15 seconds where HTTP Request allows 30) while the
 * parsing, clamping and backoff rules stay identical.
 */

import { MAX_CAUSE_DEPTH } from "@/lib/errors/cause-chain";

export type RetryAttemptLimits = {
  /** Retries used when the config value is missing or unparseable. */
  defaultAttempts: number;
  maxAttempts: number;
};

export type RetryDelayLimits = {
  /** Base delay used when the config value is missing or unparseable. */
  defaultDelaySeconds: number;
  maxDelaySeconds: number;
};

/**
 * Statuses worth another attempt: request timeout, too early, rate limited,
 * and the 5xx family that signals a transient server-side fault. Every other
 * 4xx fails identically on retry and is never retried.
 */
export const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status);
}

function toFiniteNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the retry count. Accepts numbers from MCP callers and strings from
 * the visual editor, truncates fractions, and clamps to [0, maxAttempts].
 * Anything unparseable means the default rather than an error, so a stale
 * config never blocks a request.
 */
export function resolveRetryAttempts(
  raw: unknown,
  limits: RetryAttemptLimits
): number {
  const requested = toFiniteNumber(raw);
  if (requested === undefined) {
    return limits.defaultAttempts;
  }
  return Math.min(Math.max(0, Math.trunc(requested)), limits.maxAttempts);
}

/**
 * Resolve the base backoff delay in milliseconds, clamped to
 * [0, maxDelaySeconds]. Fractional seconds are kept.
 */
export function resolveRetryDelayMs(
  raw: unknown,
  limits: RetryDelayLimits
): number {
  const requested = toFiniteNumber(raw);
  if (requested === undefined) {
    return limits.defaultDelaySeconds * 1000;
  }
  return Math.min(Math.max(0, requested), limits.maxDelaySeconds) * 1000;
}

/**
 * Linear backoff: retry N (1-based) waits N times the base delay.
 */
export function linearBackoffMs(baseDelayMs: number, retry: number): number {
  return baseDelayMs * retry;
}

/**
 * Parse a `Retry-After` header carrying delta-seconds into milliseconds.
 * Returns undefined for a missing header, a negative value, or the HTTP-date
 * form, which callers treat as "no hint" and fall back to their own backoff.
 */
export function parseRetryAfterHeaderMs(
  header: string | null | undefined
): number | undefined {
  if (!header) {
    return;
  }
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return;
  }
  return Math.ceil(seconds * 1000);
}

/**
 * Error codes that prove the request never reached the server: the socket was
 * refused, the host or network is unreachable, or the name did not resolve.
 * Deliberately excludes ECONNRESET, EPIPE and timeouts, which can happen after
 * the request body was sent and so cannot rule out a delivered request. A
 * caller retrying a non-idempotent request should retry only these.
 */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
]);

/** safeFetch resolves DNS itself and throws this before any socket opens. */
const DNS_FAILURE_MESSAGE = "Cannot resolve host:";

/**
 * True when the thrown error, or any error in its `cause` chain (undici wraps
 * socket errors in a TypeError "fetch failed"), shows the request never left
 * this process.
 */
export function isConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (typeof current !== "object") {
      return false;
    }
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && CONNECTION_FAILURE_CODES.has(code)) {
      return true;
    }
    if (
      typeof message === "string" &&
      message.startsWith(DNS_FAILURE_MESSAGE)
    ) {
      return true;
    }
    current = cause;
  }
  return false;
}
