// In-memory per-user vote rate limiter.
// Same sliding window approach as lib/mcp/rate-limit.ts.

const WINDOW_MS = 60_000; // 1 minute
const LIMIT = 20; // votes per window per user

const voteLog = new Map<string, number[]>();

export type VoteRateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export function checkVoteRateLimit(userId: string): VoteRateLimitResult {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = voteLog.get(userId);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return {
      allowed: false,
      retryAfter: Math.max(retryAfter, 1),
      limit: LIMIT,
      remaining: 0,
      reset: Math.ceil((oldestInWindow + WINDOW_MS) / 1000),
    };
  }

  recent.push(now);
  voteLog.set(userId, recent);

  const reset = Math.ceil((recent[0] + WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: LIMIT,
    remaining: LIMIT - recent.length,
    reset,
  };
}
