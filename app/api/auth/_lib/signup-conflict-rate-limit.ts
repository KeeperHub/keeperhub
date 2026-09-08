/**
 * Rate limiter for POST /api/auth/signup-conflict.
 *
 * Deliberately does NOT share buckets with credential-attempt-rate-limit.
 * That limiter guards endpoints where a password must be supplied, so an
 * attacker cannot spend a victim's budget without one. This endpoint needs
 * only an email address, so sharing the per-email bucket would let anyone
 * lock a known address out of sign-in for the whole window at zero cost.
 *
 * Two independent limiters, both consulted on every lookup:
 *   - per-email: 5 lookups per 15 minutes per normalized email
 *   - per-IP:    15 lookups per 15 minutes per client IP
 *
 * Same process-local Map storage and lazy reset as the sibling limiters. If
 * the app grows multiple replicas, swap in a Redis-backed counter keyed the
 * same way; the public API stays the same.
 */
import {
  createEmailIpLimiter,
  type RateLimitResult,
} from "@/lib/rate-limit/fixed-window";

export type SignupConflictRateLimitResult = RateLimitResult;

const limiter = createEmailIpLimiter({
  emailMax: 5,
  ipMax: 15,
  windowMs: 15 * 60 * 1000,
});

export function checkSignupConflictRateLimit(
  email: string,
  ip: string
): SignupConflictRateLimitResult {
  return limiter.check(email, ip);
}

/** Test-only hook to reset all counters between unit tests. */
export function __resetSignupConflictRateLimit(): void {
  limiter.__reset();
}
