/**
 * Shared fixed-window in-memory rate limiter, keyed independently by
 * normalized email and by client IP. Single implementation behind the
 * per-endpoint modules (credential-attempt, signup-conflict,
 * forgot-password), which instantiate it with their own limits so their
 * buckets stay isolated from each other.
 *
 * Process-local Map storage with lazy reset on read - no background timer.
 * If the app grows multiple replicas, swap in a Redis-backed counter keyed
 * the same way; the public API stays the same.
 */

type Bucket = {
  count: number;
  resetAt: number;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: "email" | "ip" };

export type EmailIpLimiter = {
  check: (email: string, ip: string) => RateLimitResult;
  /** Test-only hook to reset all counters between unit tests. */
  __reset: () => void;
};

export function createEmailIpLimiter(options: {
  emailMax: number;
  ipMax: number;
  windowMs: number;
}): EmailIpLimiter {
  const { emailMax, ipMax, windowMs } = options;
  const emailBuckets = new Map<string, Bucket>();
  const ipBuckets = new Map<string, Bucket>();

  function check(
    store: Map<string, Bucket>,
    key: string,
    max: number,
    now: number
  ): { ok: boolean; retryAfter: number } {
    const existing = store.get(key);
    if (!existing || existing.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true, retryAfter: 0 };
    }
    if (existing.count >= max) {
      return {
        ok: false,
        retryAfter: Math.ceil((existing.resetAt - now) / 1000),
      };
    }
    existing.count += 1;
    return { ok: true, retryAfter: 0 };
  }

  return {
    check(email: string, ip: string): RateLimitResult {
      const now = Date.now();
      const emailResult = check(emailBuckets, email, emailMax, now);
      if (!emailResult.ok) {
        return {
          allowed: false,
          retryAfterSeconds: emailResult.retryAfter,
          scope: "email",
        };
      }
      const ipResult = check(ipBuckets, ip, ipMax, now);
      if (!ipResult.ok) {
        return {
          allowed: false,
          retryAfterSeconds: ipResult.retryAfter,
          scope: "ip",
        };
      }
      return { allowed: true };
    },
    __reset(): void {
      emailBuckets.clear();
      ipBuckets.clear();
    },
  };
}
