// Standard rate-limit response headers, shared across REST and MCP endpoints.
// Both limiter modules (`app/api/execute/_lib/rate-limit.ts`,
// `lib/mcp/rate-limit.ts`) return results carrying `limit`/`remaining`/`reset`
// so callers can attach these headers on both success and 429 responses.
//
// Two spellings of the same facts go out together:
//
//   * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` follow the
//     IETF ratelimit-headers draft, where `Reset` is *delta seconds* until the
//     window frees a slot. This is the spelling agent runtimes and HTTP client
//     libraries look for when they self-throttle, and its absence was the
//     "no REST rate-limit headers found" finding in the agent-readiness audit.
//   * `X-RateLimit-*` is the older de-facto spelling, kept byte-identical to
//     what shipped before - `X-RateLimit-Reset` stays a Unix epoch (seconds)
//     timestamp. Existing clients (the kh CLI among them) parse it, so changing
//     its units to match the draft would silently break their backoff maths.
//
// `Retry-After` (delta seconds) is only present on a denial.

export type RateLimitHeaderInfo = {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
};

export type RateLimitHeaderOptions = {
  // Server-recommended seconds to wait before polling again. Use on status /
  // long-poll endpoints so clients don't have to guess a cadence.
  pollIntervalHint?: number;
};

/**
 * Seconds from now until the window resets, which is what the IETF draft's
 * `RateLimit-Reset` carries (as opposed to the epoch timestamp `X-RateLimit-Reset`
 * has always carried). Never negative: a window whose reset has already passed
 * reports 0, meaning "retry now".
 */
function resetDeltaSeconds(reset: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.max(0, reset - nowSeconds);
}

export function rateLimitHeaders(
  info: RateLimitHeaderInfo,
  options?: RateLimitHeaderOptions
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(info.limit),
    "RateLimit-Remaining": String(info.remaining),
    "RateLimit-Reset": String(resetDeltaSeconds(info.reset)),
    "X-RateLimit-Limit": String(info.limit),
    "X-RateLimit-Remaining": String(info.remaining),
    "X-RateLimit-Reset": String(info.reset),
  };
  if (info.retryAfter !== undefined) {
    headers["Retry-After"] = String(info.retryAfter);
  }
  if (options?.pollIntervalHint !== undefined) {
    headers["X-Poll-Interval-Hint"] = String(options.pollIntervalHint);
  }
  return headers;
}

// Mutates and returns the response with the standard rate-limit headers set.
// Works on both `Response` and Next.js `NextResponse` (shared `headers` API).
export function applyRateLimitHeaders<T extends Response>(
  response: T,
  info: RateLimitHeaderInfo,
  options?: RateLimitHeaderOptions
): T {
  const headers = rateLimitHeaders(info, options);
  try {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    // A few Response variants (e.g. redirects) carry immutable headers and
    // throw on set; rebuild with the extra headers merged in.
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) {
      merged.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    }) as T;
  }
}
