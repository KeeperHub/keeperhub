// In-memory per-user vote rate limiter, built on the shared sliding window.

import {
  createSlidingWindowLimiter,
  type SlidingWindowRateLimitResult,
} from "@/lib/rate-limit/sliding-window";
import { MINUTE_MS } from "@/lib/utils/duration";

const WINDOW_MS = MINUTE_MS;
const LIMIT = 20; // votes per window per user

const limiter = createSlidingWindowLimiter({
  limit: LIMIT,
  windowMs: WINDOW_MS,
});

export type VoteRateLimitResult = SlidingWindowRateLimitResult;

export function checkVoteRateLimit(userId: string): VoteRateLimitResult {
  return limiter.check(userId);
}
