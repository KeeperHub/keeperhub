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
import {
  createEmailIpLimiter,
  type RateLimitResult,
} from "@/lib/rate-limit/fixed-window";

export type { RateLimitResult } from "@/lib/rate-limit/fixed-window";

const limiter = createEmailIpLimiter({
  emailMax: 5,
  ipMax: 20,
  windowMs: 15 * 60 * 1000,
});

export function checkCredentialAttemptRateLimit(
  email: string,
  ip: string
): RateLimitResult {
  return limiter.check(email, ip);
}

/** Test-only hook to reset all counters between unit tests. */
export function __resetCredentialAttemptRateLimit(): void {
  limiter.__reset();
}
