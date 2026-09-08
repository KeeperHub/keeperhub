// In-memory per pod. In a multi-replica deployment, each pod tracks its own window.
// Effective limit is LIMIT * num_replicas. Replace with Redis-backed solution
// (HARD-03) when replica count grows. See STATE.md pending todo to confirm K8s
// replica count before adjusting LIMIT.

import {
  createSlidingWindowLimiter,
  type SlidingWindowRateLimitResult,
} from "@/lib/rate-limit/sliding-window";

const WINDOW_MS = 60_000; // 1 minute
const LIMIT = 60; // requests per window

export type RateLimitResult = SlidingWindowRateLimitResult;

const limiter = createSlidingWindowLimiter({
  limit: LIMIT,
  windowMs: WINDOW_MS,
});

export function checkRateLimit(apiKeyId: string): RateLimitResult {
  return limiter.check(apiKeyId);
}
