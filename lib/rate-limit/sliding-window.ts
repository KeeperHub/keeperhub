/**
 * Shared sliding-window in-memory rate limiter. Single implementation
 * behind the per-endpoint modules (execute, ai generate, billing,
 * invitations), which instantiate it with their own limit/window so their
 * buckets stay isolated from each other.
 *
 * In-memory per pod: in a multi-replica deployment each pod tracks its own
 * window, so the effective limit is limit * num_replicas. Replace with a
 * Redis-backed solution when replica count grows.
 *
 * Not used by lib/mcp/rate-limit.ts (module-level stale-entry sweep and a
 * per-call limit/window IP variant) or
 * app/api/user/wallet/export-key/_lib/rate-limit.ts (minimal result shape,
 * amortised eviction) - those diverge from this shape on purpose.
 *
 * lib/workflow/editor/vote-rate-limit.ts and lib/mfa/dual-factor-rate-limit.ts
 * were hand-rolled copies of this algorithm; both now build on it. The
 * per-key reset the latter needed is exposed as reset().
 */

export type SlidingWindowRateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export type SlidingWindowLimiter = {
  check: (key: string) => SlidingWindowRateLimitResult;
  /** Clear one key's window, e.g. after a success that should not count. */
  reset: (key: string) => void;
  /** Test-only hook to reset all counters between unit tests. */
  __reset: () => void;
};

export function createSlidingWindowLimiter(options: {
  limit: number;
  windowMs: number;
}): SlidingWindowLimiter {
  const { limit, windowMs } = options;
  const requestLog = new Map<string, number[]>();

  return {
    check(key: string): SlidingWindowRateLimitResult {
      const now = Date.now();
      const windowStart = now - windowMs;

      const timestamps = requestLog.get(key);
      const recent = timestamps
        ? timestamps.filter((t) => t > windowStart)
        : [];

      if (recent.length >= limit) {
        // Oldest timestamp in window determines when the first slot opens
        const oldestInWindow = recent[0];
        const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
        return {
          allowed: false,
          retryAfter: Math.max(retryAfter, 1),
          limit,
          remaining: 0,
          reset: Math.ceil((oldestInWindow + windowMs) / 1000),
        };
      }

      recent.push(now);
      requestLog.set(key, recent);

      // Window frees a slot when its oldest in-window request expires.
      const reset = Math.ceil((recent[0] + windowMs) / 1000);
      return {
        allowed: true,
        limit,
        remaining: limit - recent.length,
        reset,
      };
    },
    reset(key: string): void {
      requestLog.delete(key);
    },
    __reset(): void {
      requestLog.clear();
    },
  };
}
