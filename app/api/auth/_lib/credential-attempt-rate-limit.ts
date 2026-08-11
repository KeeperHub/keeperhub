/**
 * Shared in-memory rate limiter for the unauthenticated credential-password
 * endpoints (F-013 / KEEP-738). Both POST /api/auth/finish-credential-signup
 * and POST /api/auth/strict-signin/start verify a credential password for any
 * caller and return a distinguishable 401 vs 200, so without throttling each is
 * an unauthenticated password oracle (strict-signin/start is the broader one:
 * a correct password signs a non-TOTP user straight in). Neither sits under
 * the Better Auth `/api/auth/[...all]` catch-all, so Better Auth's rateLimit
 * does not cover them.
 *
 * Buckets are SHARED across both endpoints, keyed by normalized email and by
 * client IP, so an attacker cannot get a fresh allowance by hopping between the
 * two routes for the same target.
 *
 * Two independent limiters, both consulted on every attempt:
 *   - per-email: 5 attempts per 15 minutes per normalized email
 *   - per-IP:    20 attempts per 15 minutes per client IP
 *
 * Mirrors app/api/user/forgot-password/_lib/rate-limit.ts: process-local Map
 * storage, lazy reset on read, no background timer. If the app grows multiple
 * replicas, swap in a Redis-backed counter keyed the same way; the public API
 * stays the same.
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

export function checkCredentialAttemptRateLimit(
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
export function __resetCredentialAttemptRateLimit(): void {
  emailBuckets.clear();
  ipBuckets.clear();
}
