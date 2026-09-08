import "server-only";

/**
 * Per-process TTL cache for the analytics read paths.
 *
 * The /analytics dashboard fans out summary / time-series / networks on every
 * load AND the SSE stream recomputes the summary whenever an org's checksum
 * changes (see lib/analytics/stream-start.ts). For a busy org that is a full
 * aggregation - including the unindexed JSONB gas scans over
 * workflow_execution_logs - every few seconds per connected viewer. This cache
 * collapses that: callers for the same (org, range, project, window) within the
 * TTL share a single DB round-trip, and concurrent callers during an in-flight
 * refresh share the same promise instead of each starting their own scan.
 *
 * Mirrors the proven shape of the /api/metrics/db cache
 * (lib/metrics/collectors/prometheus.ts): monotonic performance.now()
 * timestamps, TTL measured from completion (not start), in-flight dedup past
 * the TTL so a slow refresh under DB stress cannot be amplified, and eviction
 * on failure so the next caller retries instead of seeing a pinned error.
 *
 * Set ANALYTICS_CACHE_TTL_MS=0 to disable (recompute on every call).
 */

const DEFAULT_ANALYTICS_CACHE_TTL_MS = 30_000;

function getAnalyticsCacheTtlMs(): number {
  const raw = process.env.ANALYTICS_CACHE_TTL_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_ANALYTICS_CACHE_TTL_MS;
  }
  // Number() (not parseInt) so trailing junk like "30s" is rejected outright
  // rather than silently parsed as 30, which would be a 1000x-wrong TTL.
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_ANALYTICS_CACHE_TTL_MS;
}

type CacheEntry = {
  // Monotonic timestamps from performance.now(): wall-clock can step backwards
  // on NTP adjustments and invalidate the TTL math.
  startedAt: number;
  completedAt: number | null;
  promise: Promise<unknown>;
};

const cache = new Map<string, CacheEntry>();

/**
 * Build a stable cache key. Undefined parts collapse to "" so the key is
 * deterministic regardless of which optional filters are present.
 */
export function analyticsCacheKey(
  scope: string,
  parts: (string | undefined)[]
): string {
  return [scope, ...parts.map((p) => p ?? "")].join("|");
}

/**
 * Run `loader` behind the TTL cache for `key`. Rejections propagate to the
 * caller (the routes and the SSE start already handle their own errors) and
 * evict the slot so the failure is not cached.
 */
export function cachedAnalytics<T>(
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const ttl = getAnalyticsCacheTtlMs();
  if (ttl <= 0) {
    return loader();
  }

  const existing = cache.get(key);
  if (existing) {
    // In-flight: share the promise regardless of TTL so a refresh that is
    // slower than the TTL cannot spawn a second concurrent scan.
    if (existing.completedAt === null) {
      return existing.promise as Promise<T>;
    }
    // Completed: serve cached while within TTL of completion.
    if (performance.now() - existing.completedAt < ttl) {
      return existing.promise as Promise<T>;
    }
  }

  const promise = loader();
  const entry: CacheEntry = {
    startedAt: performance.now(),
    completedAt: null,
    promise,
  };
  cache.set(key, entry);

  // Bookkeeping only. The two-arg form avoids creating an orphan rejected
  // promise (which would surface as an unhandled rejection); the trailing
  // .catch guards against the settle callbacks themselves throwing.
  promise
    .then(
      () => {
        entry.completedAt = performance.now();
      },
      () => {
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
      }
    )
    .catch(() => {
      // settle callback threw; nothing actionable here
    });

  return promise;
}

/**
 * Clear the cache. Test-only - throws outside NODE_ENV=test so production code
 * that calls it by mistake fails loud instead of silently dropping the cache.
 */
export function __resetAnalyticsCacheForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__resetAnalyticsCacheForTest is test-only; do not call in production"
    );
  }
  cache.clear();
}
