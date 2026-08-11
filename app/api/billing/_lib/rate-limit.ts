// Sliding-window limiter for the owner-authenticated billing mutation routes
// (checkout, preview-proration). In-memory per pod, so in a multi-replica
// deployment the effective limit is LIMIT * num_replicas. Both callers resolve
// an org via requireOrgOwner, so the bucket is the org id (an owner cannot burn
// another org's quota). Replace with a Redis-backed limiter if this grows hot.

const WINDOW_MS = 60_000;
const LIMIT = 20;

const requestLog = new Map<string, number[]>();

export type BillingRateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export function checkBillingRateLimit(orgId: string): BillingRateLimitResult {
  const key = `org:${orgId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = requestLog.get(key);
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
  requestLog.set(key, recent);

  return {
    allowed: true,
    limit: LIMIT,
    remaining: LIMIT - recent.length,
    reset: Math.ceil((recent[0] + WINDOW_MS) / 1000),
  };
}

// Test-only reset hook. Production code never imports this.
export function __resetBillingRateLimitForTests(): void {
  requestLog.clear();
}
