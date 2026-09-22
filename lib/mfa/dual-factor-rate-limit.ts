/**
 * Per-(user, action) sliding-window counter for requireDualFactor.
 *
 * Each POST to a dual-factor-guarded endpoint registers an attempt
 * for the same (userId, action) key, regardless of whether codes are
 * present. That covers both attack surfaces:
 *
 *   - Empty-body floods: attacker submits the dual-factor endpoint
 *     with no codes to force fresh email OTPs at the victim's inbox.
 *   - Brute-force guesses: attacker has stolen one factor and tries
 *     to guess the other across a live verifications row.
 *
 * In-memory per pod, on the shared sliding window in
 * lib/rate-limit/sliding-window.ts. In a multi-replica deployment each pod
 * tracks its own window; effective limit is LIMIT_PER_WINDOW * num_replicas.
 * Migrate to Redis when replica count starts to matter.
 *
 * On a successful dual-factor verify the caller invokes `resetDualFactor`
 * to wipe the counter; this prevents a legitimately-confused user
 * from running out of room after a few typos before they finally hit
 * the right codes.
 *
 * The result shape stays narrower than the shared limiter's on purpose:
 * callers here only ever need allowed/retryAfter.
 */

import { createSlidingWindowLimiter } from "@/lib/rate-limit/sliding-window";
import { MINUTE_MS } from "@/lib/utils/duration";

const WINDOW_MS = 15 * MINUTE_MS;
const LIMIT_PER_WINDOW = 10;

const limiter = createSlidingWindowLimiter({
  limit: LIMIT_PER_WINDOW,
  windowMs: WINDOW_MS,
});

const keyFor = (userId: string, action: string): string =>
  `${userId}:${action}`;

export type DualFactorRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

export function checkDualFactorRateLimit(
  userId: string,
  action: string
): DualFactorRateLimitResult {
  const result = limiter.check(keyFor(userId, action));
  return result.allowed
    ? { allowed: true }
    : { allowed: false, retryAfter: result.retryAfter };
}

export function resetDualFactor(userId: string, action: string): void {
  limiter.reset(keyFor(userId, action));
}

// Test-only: wipe all tracked windows.
export function resetDualFactorRateLimitState(): void {
  limiter.__reset();
}
