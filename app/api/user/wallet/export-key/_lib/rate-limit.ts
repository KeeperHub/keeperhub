// Per-user in-memory rate limiter for wallet export endpoints. Per pod, so
// the effective limit is LIMIT * num_replicas; acceptable at current replica
// count. Redis-backed is a project-wide decision (see the same caveat on
// app/api/execute/_lib/rate-limit.ts).

type Bucket = { limit: number; windowMs: number };

const REQUEST_BUCKET: Bucket = { limit: 3, windowMs: 5 * 60_000 };
const VERIFY_BUCKET: Bucket = { limit: 10, windowMs: 5 * 60_000 };

const requestLog = new Map<string, number[]>();
const verifyLog = new Map<string, number[]>();

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

function check(
  store: Map<string, number[]>,
  bucket: Bucket,
  key: string
): RateLimitResult {
  const now = Date.now();
  const windowStart = now - bucket.windowMs;

  const timestamps = store.get(key);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= bucket.limit) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil(
      (oldestInWindow + bucket.windowMs - now) / 1000
    );
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  recent.push(now);
  store.set(key, recent);
  return { allowed: true };
}

// Evict entries whose most recent hit is older than the bucket window, so the
// Map does not grow unbounded across unique user ids over time.
function evictStale(store: Map<string, number[]>, windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  for (const [key, timestamps] of store) {
    const mostRecent = timestamps.at(-1);
    if (mostRecent === undefined || mostRecent <= cutoff) {
      store.delete(key);
    }
  }
}

// Sweep once every N calls rather than on a timer so tests stay deterministic
// without fake clocks. N is large enough that the per-call amortised cost is
// negligible, small enough that a quiet period after a spike cleans up soon.
const SWEEP_EVERY_N_CALLS = 256;
let requestCallsSinceSweep = 0;
let verifyCallsSinceSweep = 0;

export function checkRequestRateLimit(userId: string): RateLimitResult {
  if (++requestCallsSinceSweep >= SWEEP_EVERY_N_CALLS) {
    requestCallsSinceSweep = 0;
    evictStale(requestLog, REQUEST_BUCKET.windowMs);
  }
  return check(requestLog, REQUEST_BUCKET, userId);
}

export function checkVerifyRateLimit(userId: string): RateLimitResult {
  if (++verifyCallsSinceSweep >= SWEEP_EVERY_N_CALLS) {
    verifyCallsSinceSweep = 0;
    evictStale(verifyLog, VERIFY_BUCKET.windowMs);
  }
  return check(verifyLog, VERIFY_BUCKET, userId);
}

// Test-only helper to reset all internal state between tests. Not exported
// from a barrel file; callers must reach in via the full module path.
export function __resetRateLimitForTesting(): void {
  requestLog.clear();
  verifyLog.clear();
  requestCallsSinceSweep = 0;
  verifyCallsSinceSweep = 0;
}
