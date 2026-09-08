// Rate limits for the MCP surface.
//
// The per-organization limiter is Redis-backed so the ceiling is fleet-wide.
// It previously lived in a module-level Map, which made the real ceiling
// LIMIT * num_replicas: an agent spraying requests across pods got a multiple
// of the intended budget. Prod runs replicaCount 4
// (deploy/keeperhub-stack/prod/values.yaml), so the advertised 120/min was
// really 480/min and this change cuts the effective ceiling by three quarters.
// Staging runs 1 replica, so the limit there is already 120/min and the change
// is a no-op: staging cannot surface the impact before prod does.
//
// The per-IP limiter below is still in-memory per pod, and is not built on
// lib/rate-limit/sliding-window.ts: the stale-entry sweep below iterates this
// module's maps directly, and checkIpRateLimit takes a per-call limit/window
// (feeding the tracked maxWindowMs), neither of which fits the shared
// fixed-config factory.

import type { Redis } from "ioredis";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { getRedis } from "@/lib/redis";
import { mcpRateLimitKey } from "@/lib/redis-keys";

export const WINDOW_MS = 60_000; // 1 minute
export const LIMIT = 120; // requests per window (higher than execute endpoint; MCP sessions are chatty)

// Stale-entry sweep: anything whose newest timestamp is older than
// (STALE_THRESHOLD_MULTIPLIER * maxWindowMs) can never affect a rate-limit
// decision and exists only as map-key overhead. The largest window is
// tracked dynamically so future callers with longer windows are safe by
// construction -- no caller can introduce a window that races the sweep.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MULTIPLIER = 5;

// Hard cap on keys tracked by each in-memory map. The organization map only
// fills while Redis is down, but the IP map is reachable by unauthenticated
// callers who can rotate source addresses freely between sweeps, so both are
// bounded: an evicted key gets a fresh window, which is strictly better than
// the pod running out of memory.
const MAX_TRACKED_KEYS = 10_000;

const DEGRADED_LOG_INTERVAL_MS = 60_000;

const requestLog = new Map<string, number[]>();
const ipRequestLog = new Map<string, number[]>();

let maxWindowMs = WINDOW_MS;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastDegradedLogAt = 0;
let memberSequence = 0;
let connectAttempt: Promise<void> | null = null;

// Unique per process so two pods adding a member in the same millisecond
// cannot collide on the same sorted-set entry and silently merge two
// requests into one.
const PROCESS_TOKEN = globalThis.crypto.randomUUID();

export type RateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

// Sliding window over a sorted set, scored by request timestamp. Trim, count
// and add have to happen in one server-side step: split across round trips,
// two concurrent requests both read a count below the limit and both get
// admitted, which is a bypass of exactly the size of the concurrency.
//
// Sliding rather than fixed window because a fixed window admits 2 * LIMIT
// across a boundary, and because it preserves the reset/retryAfter semantics
// the existing callers and headers already expose.
//
// The window is scored by Redis's own clock, not the calling pod's: replicas
// only share a window if they agree on what time it is, and a pod whose clock
// drifts past the window length would write entries every other replica
// immediately trims, quietly buying itself a private budget. TIME is safe
// inside a script under effect replication (Redis 5+).
//
// Returns { allowed, count-in-window, oldest-score-ms, server-now-ms }.
export const MCP_SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)

if count >= limit then
  local head = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest = now
  if head[2] then oldest = tonumber(head[2]) end
  return {0, count, oldest, now}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)

local head = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldest = now
if head[2] then oldest = tonumber(head[2]) end
return {1, count + 1, oldest, now}
`;

function nextMember(): string {
  memberSequence += 1;
  return `${PROCESS_TOKEN}-${memberSequence}`;
}

function buildResult(input: {
  allowed: boolean;
  count: number;
  oldestMs: number;
  now: number;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const { allowed, count, oldestMs, now, limit, windowMs } = input;
  // The oldest request in the window is what frees the next slot.
  const resetMs = oldestMs + windowMs;
  const reset = Math.ceil(resetMs / 1000);

  if (allowed) {
    return {
      allowed: true,
      limit,
      remaining: Math.max(limit - count, 0),
      reset,
    };
  }

  return {
    allowed: false,
    retryAfter: Math.max(Math.ceil((resetMs - now) / 1000), 1),
    limit,
    remaining: 0,
    reset,
  };
}

function parseWindowReply(
  reply: unknown
): { allowed: boolean; count: number; oldestMs: number; now: number } | null {
  if (!Array.isArray(reply) || reply.length < 4) {
    return null;
  }
  const [allowed, count, oldestMs, now] = reply.map(Number);
  if (
    !(
      Number.isFinite(allowed) &&
      Number.isFinite(count) &&
      Number.isFinite(oldestMs) &&
      Number.isFinite(now)
    )
  ) {
    return null;
  }
  return { allowed: allowed === 1, count, oldestMs, now };
}

function describeReply(reply: unknown): string {
  if (Array.isArray(reply)) {
    return `array(length=${reply.length})`;
  }
  if (typeof reply === "string") {
    return `string("${reply.slice(0, 64)}")`;
  }
  return reply === null ? "null" : typeof reply;
}

// Losing Redis means losing the shared counter, not the limit. The fallback
// below keeps enforcing LIMIT per replica, so an outage degrades the ceiling
// to what it was before this module was Redis-backed rather than removing it:
// failing open would hand an attacker an unmetered MCP endpoint at precisely
// the moment the platform is least healthy.
//
// The counter carries every degraded decision so a dashboard can answer
// whether the shared ceiling is actually being enforced. The Sentry warning is
// throttled instead, because it sits on the request hot path.
function recordDegraded(reason: string, error: unknown): void {
  getMetricsCollector().incrementCounter(MetricNames.MCP_RATE_LIMIT_DEGRADED, {
    reason,
  });

  const now = Date.now();
  if (now - lastDegradedLogAt < DEGRADED_LOG_INTERVAL_MS) {
    return;
  }
  lastDegradedLogAt = now;
  logSystemWarn(
    ErrorCategory.INFRASTRUCTURE,
    `[MCP Rate Limit] Redis unavailable (${reason}), falling back to per-pod limiting`,
    error,
    { operation: "mcp_rate_limit", reason }
  );
}

// The shared client is created with lazyConnect and enableOfflineQueue=false,
// so the very first command on a cold client is rejected outright while the
// socket is still opening. Left alone that turns every process start into a
// bogus "Redis unavailable" report, and the throttled warning would then hide
// a genuine outage for the rest of the minute. Open the connection explicitly
// and wait for it instead of firing a command into a socket that cannot yet
// carry it.
function ensureConnected(redis: Redis): Promise<void> {
  if (typeof redis.connect !== "function") {
    return Promise.resolve();
  }
  if (redis.status === "wait") {
    // Rejections here are not swallowed silently: the command that follows
    // fails too and is reported as a degradation with its own error.
    connectAttempt ??= redis.connect().then(
      () => undefined,
      () => undefined
    );
  }
  return connectAttempt ?? Promise.resolve();
}

/**
 * Opens the shared Redis connection ahead of the first request. Idempotent,
 * never rejects. Called at boot from instrumentation so no request pays the
 * connection setup or is mistaken for an outage.
 */
export function warmRateLimitRedis(): Promise<void> {
  const redis = getRedis();
  return redis ? ensureConnected(redis) : Promise.resolve();
}

// Map iteration follows insertion order, so re-inserting a key on every touch
// makes the first key the least recently used one and eviction O(1). Scanning
// for the stalest entry instead would run over the whole map on every request
// from an untracked key once it is full -- extra CPU exactly when the platform
// is already degraded.
function touchTrackedKey(
  log: Map<string, number[]>,
  key: string,
  timestamps: number[]
): void {
  log.delete(key);
  if (log.size >= MAX_TRACKED_KEYS) {
    const leastRecent = log.keys().next().value;
    if (leastRecent !== undefined) {
      log.delete(leastRecent);
    }
  }
  log.set(key, timestamps);
}

function checkInMemoryWindow(
  log: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): RateLimitResult {
  const windowStart = now - windowMs;
  const timestamps = log.get(key);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];
  const denied = recent.length >= limit;

  if (!denied) {
    recent.push(now);
  }
  // Denied callers are written back too: a key being actively refused is the
  // last one that should be evicted, since eviction hands it a fresh window.
  touchTrackedKey(log, key, recent);

  return buildResult({
    allowed: !denied,
    count: recent.length,
    oldestMs: recent[0],
    now,
    limit,
    windowMs,
  });
}

export async function checkMcpRateLimit(
  organizationId: string
): Promise<RateLimitResult> {
  const redis = getRedis();

  if (redis) {
    if (redis.status !== "ready") {
      await ensureConnected(redis);
    }
    try {
      const reply = await redis.eval(
        MCP_SLIDING_WINDOW_SCRIPT,
        1,
        mcpRateLimitKey(organizationId),
        WINDOW_MS,
        LIMIT,
        nextMember()
      );
      const parsed = parseWindowReply(reply);
      if (parsed) {
        return buildResult({
          ...parsed,
          limit: LIMIT,
          windowMs: WINDOW_MS,
        });
      }
      recordDegraded(
        "unexpected_reply",
        new Error(`unexpected reply: ${describeReply(reply)}`)
      );
    } catch (error) {
      recordDegraded("command_failed", error);
    }
  }

  return checkInMemoryWindow(
    requestLog,
    organizationId,
    LIMIT,
    WINDOW_MS,
    Date.now()
  );
}

export function checkIpRateLimit(
  ip: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  if (windowMs > maxWindowMs) {
    maxWindowMs = windowMs;
  }
  return checkInMemoryWindow(ipRequestLog, ip, limit, windowMs, Date.now());
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

// Tracked-entry counts. Useful for /healthz or memory observability. The
// organization count only moves while the Redis-backed limiter is degraded.
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
  lastDegradedLogAt = 0;
  connectAttempt = null;
}
