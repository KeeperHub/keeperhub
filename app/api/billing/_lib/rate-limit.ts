// Sliding-window limiter for the owner-authenticated billing mutation routes
// (checkout, preview-proration). In-memory per pod, so in a multi-replica
// deployment the effective limit is LIMIT * num_replicas. Both callers resolve
// an org via requireOrgOwner, so the bucket is the org id (an owner cannot burn
// another org's quota). Replace with a Redis-backed limiter if this grows hot.

import {
  createSlidingWindowLimiter,
  type SlidingWindowRateLimitResult,
} from "@/lib/rate-limit/sliding-window";

const WINDOW_MS = 60_000;
const LIMIT = 20;

export type BillingRateLimitResult = SlidingWindowRateLimitResult;

const limiter = createSlidingWindowLimiter({
  limit: LIMIT,
  windowMs: WINDOW_MS,
});

export function checkBillingRateLimit(orgId: string): BillingRateLimitResult {
  return limiter.check(`org:${orgId}`);
}

// Test-only reset hook. Production code never imports this.
export function __resetBillingRateLimitForTests(): void {
  limiter.__reset();
}
