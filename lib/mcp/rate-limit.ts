// In-memory per pod. In a multi-replica deployment, each pod tracks its own window.
// Effective limit is LIMIT * num_replicas. Replace with Redis-backed solution
// when replica count grows.

export const WINDOW_MS = 60_000; // 1 minute
export const LIMIT = 120; // requests per window (higher than execute endpoint; MCP sessions are chatty)

// Stale-entry sweep: anything whose newest timestamp is older than
// (STALE_THRESHOLD_MULTIPLIER * maxWindowMs) can never affect a rate-limit
// decision and exists only as map-key overhead. The largest window is
// tracked dynamically so future callers with longer windows are safe by
// construction -- no caller can introduce a window that races the sweep.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MULTIPLIER = 5;

const requestLog = new Map<string, number[]>();
const ipRequestLog = new Map<string, number[]>();

let maxWindowMs = WINDOW_MS;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export type RateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export function checkMcpRateLimit(organizationId: string): RateLimitResult {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = requestLog.get(organizationId);
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
  requestLog.set(organizationId, recent);

  const reset = Math.ceil((recent[0] + WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: LIMIT,
    remaining: LIMIT - recent.length,
    reset,
  };
}

export function checkIpRateLimit(
  ip: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  if (windowMs > maxWindowMs) {
    maxWindowMs = windowMs;
  }
  const now = Date.now();
  const windowStart = now - windowMs;

  const timestamps = ipRequestLog.get(ip);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= limit) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return {
      allowed: false,
      retryAfter: Math.max(retryAfter, 1),
      limit,
      remaining: 0,
      reset: Math.ceil((oldestInWindow + windowMs) / 1000),
    };
  }

  recent.push(now);
  ipRequestLog.set(ip, recent);

  const reset = Math.ceil((recent[0] + windowMs) / 1000);
  return { allowed: true, limit, remaining: limit - recent.length, reset };
}

export function getClientIp(request: Request): string {
  // Prefer `cf-connecting-ip`: Cloudflare sets it to the real client IP at the
  // edge and overwrites any client-supplied value, so it cannot be spoofed to
  // defeat per-IP rate limits. `x-forwarded-for`/`x-real-ip` are attacker-
  // controllable and only used as a fallback for non-CF/local environments.
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) {
    return cfIp;
  }
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// Walk both maps and drop entries whose newest timestamp is older than the
// stale threshold. Inline cleanup on the request path can't fix this leak
// because it only fires when the same key comes back; entries leak when an
// org/IP makes requests once and never returns.
export function cleanupExpiredRateLimitEntries(): void {
  const cutoff = Date.now() - maxWindowMs * STALE_THRESHOLD_MULTIPLIER;
  for (const map of [requestLog, ipRequestLog]) {
    for (const [key, timestamps] of map) {
      const newest = timestamps.at(-1);
      if (newest === undefined || newest <= cutoff) {
        map.delete(key);
      }
    }
  }
}

export function startRateLimitCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
  }
  // Run a sweep immediately so a re-init (HMR, error-recovery path, etc.)
  // doesn't have to wait CLEANUP_INTERVAL_MS to clean entries left over
  // from before the restart. At server boot the maps are empty so this is
  // a cheap no-op.
  cleanupExpiredRateLimitEntries();
  cleanupTimer = setInterval(
    cleanupExpiredRateLimitEntries,
    CLEANUP_INTERVAL_MS
  );
  if (
    cleanupTimer !== null &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    cleanupTimer.unref();
  }
}

export function stopRateLimitCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Tracked-entry counts. Useful for /healthz or memory observability.
export function getRateLimitStats(): {
  organizationCount: number;
  ipCount: number;
} {
  return {
    organizationCount: requestLog.size,
    ipCount: ipRequestLog.size,
  };
}

// Test-only: clears all in-process state (maps + tracked window). Tests need
// this because `maxWindowMs` is module-scoped and can otherwise leak between
// cases that exercise different window sizes.
export function resetRateLimitState(): void {
  requestLog.clear();
  ipRequestLog.clear();
  maxWindowMs = WINDOW_MS;
}
