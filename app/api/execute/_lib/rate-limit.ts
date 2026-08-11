// In-memory per pod. In a multi-replica deployment, each pod tracks its own window.
// Effective limit is LIMIT * num_replicas. Replace with Redis-backed solution
// (HARD-03) when replica count grows. See STATE.md pending todo to confirm K8s
// replica count before adjusting LIMIT.

const WINDOW_MS = 60_000; // 1 minute
const LIMIT = 60; // requests per window

const requestLog = new Map<string, number[]>();

export type RateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export function checkRateLimit(apiKeyId: string): RateLimitResult {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = requestLog.get(apiKeyId);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT) {
    // Oldest timestamp in window determines when the first slot opens
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
  requestLog.set(apiKeyId, recent);

  // Window frees a slot when its oldest in-window request expires.
  const reset = Math.ceil((recent[0] + WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: LIMIT,
    remaining: LIMIT - recent.length,
    reset,
  };
}
