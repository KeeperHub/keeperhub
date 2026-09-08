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

export function checkForgotPasswordRateLimit(
  email: string,
  ip: string
): RateLimitResult {
  return limiter.check(email, ip);
}

/** Test-only hook to reset all counters between unit tests. */
export function __resetForgotPasswordRateLimit(): void {
  limiter.__reset();
}
