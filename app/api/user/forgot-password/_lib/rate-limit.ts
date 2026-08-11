/**
 * In-memory rate limiter for the forgot-password endpoint. KEEP-625
 * scope: a flooding attacker should not be able to mint reset codes
 * for many users from a single IP, nor brute-force a single email by
 * rapid-firing requests until they catch a code they can read from
 * the DB / inbox.
 *
 * Two independent limiters, both consulted on every request:
 *   - per-email: 5 requests per 15 minutes per normalized email
 *   - per-IP:    20 requests per 15 minutes per IP
 *
 * Process-local Map storage. Acceptable here because the request
 * volume is low and the consequence of a missed window across a
 * restart is "one extra reset attempt slips through." If the app
 * grows multiple replicas, replace with a Redis-backed counter
 * keyed the same way; the public API stays the same.
 *
 * Window resets on the next request that arrives after window
 * expiry — no background timer, just lazy reset on read.
 */

const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_MAX = 5;
const IP_MAX = 20;

type Bucket = {
  count: number;
  resetAt: number;
};

const emailBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: "email" | "ip" };

function check(
  store: Map<string, Bucket>,
  key: string,
  max: number,
  now: number
): { ok: boolean; retryAfter: number } {
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
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

export function checkForgotPasswordRateLimit(
  email: string,
  ip: string
): RateLimitResult {
  const now = Date.now();
  const emailResult = check(emailBuckets, email, EMAIL_MAX, now);
  if (!emailResult.ok) {
    return {
      allowed: false,
      retryAfterSeconds: emailResult.retryAfter,
      scope: "email",
    };
  }
  const ipResult = check(ipBuckets, ip, IP_MAX, now);
  if (!ipResult.ok) {
    return {
      allowed: false,
      retryAfterSeconds: ipResult.retryAfter,
      scope: "ip",
    };
  }
  return { allowed: true };
}

/** Test-only hook to reset all counters between unit tests. */
export function __resetForgotPasswordRateLimit(): void {
  emailBuckets.clear();
  ipBuckets.clear();
}
