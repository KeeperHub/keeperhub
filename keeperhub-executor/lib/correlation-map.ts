/**
 * Correlation-id lookup for latency observations (issue #2289).
 *
 * The executor creates an ExecutionLatency per SQS message, but the runner
 * pod's observations arrive asynchronously over the metrics ingest, after the
 * message handler has moved on. This bounded map lets the ingest applier find
 * the originating timeline by correlation id. Entries are removed when their
 * received-completed observation is applied; two bounds keep a pathological
 * ingest stream from growing the map without bound - an age bound against the
 * run's own `received` stamp, and a count cap as the backstop.
 *
 * The age bound is the one that matters. Plenty of tracked runs never produce
 * an observation to free them: in-process runs and api-target runs ship
 * nothing, a message can be dropped before dispatch, and a runner pod can die
 * before its ingest lands. Under a count-only cap those entries turn the 1024
 * slots over on message *volume*, so a run slower than that window has its
 * entry evicted before its own observation arrives - it is counted `skipped`
 * and the histogram loses exactly the slow runs it exists to surface. Bounding
 * by age makes eviction depend on how long the entry has waited rather than on
 * how busy the executor is.
 */

import type { ExecutionLatency } from "../latency";

const MAX_TRACKED = 1024;

/**
 * How long a tracked entry may wait for observations before it is dropped.
 *
 * An hour is deliberately far outside the range of any legitimate wait, in both
 * directions:
 *
 *  - Entries that *do* ship belong to k8s-job runs, and that Job is bounded by
 *    `activeDeadlineSeconds` (CONFIG.jobActiveDeadline, 300s by default) with the
 *    ingest landing moments after the run ends. An hour is therefore twelve times
 *    the longest wait the platform can produce - not a tuned threshold, but a
 *    bound nothing legitimate can approach.
 *  - Entries that never ship - in-process and api runs, and messages dropped
 *    before dispatch - are the reason this bound exists at all. Reclaiming those
 *    at an hour rather than immediately is the conservative end, and the asymmetry
 *    decides it: being slow costs a held slot, being eager costs a real sample.
 *
 * One assumption, written down because it is invisible from here: if
 * `JOB_ACTIVE_DEADLINE` is raised far above its default, this bound has to rise
 * with it.
 */
const MAX_TRACKED_AGE_MS = 60 * 60 * 1000;

const map = new Map<string, TrackedEntry>();

type TrackedEntry = {
  latency: ExecutionLatency;
  /** The run's own receive stamp, or the tracking time when it has none. */
  trackedAt: number;
};

/**
 * Drop entries that have waited longer than MAX_TRACKED_AGE_MS. The map is
 * capped at 1024 entries, so this is a bounded scan of a tiny set on the track
 * path, and it runs before the cap check so age - not arrival order - decides
 * what to give up.
 */
function evictStale(now: number): void {
  for (const [id, entry] of map) {
    if (now - entry.trackedAt > MAX_TRACKED_AGE_MS) {
      map.delete(id);
    }
  }
}

/** Track the timeline for a run from SQS receive until its observations land. */
export function trackLatency(latency: ExecutionLatency): void {
  const now = Date.now();
  evictStale(now);
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(latency.correlationId, {
    latency,
    trackedAt: latency.at("received") ?? now,
  });
}

/** Peek without removing (observed-broadcast arrives before completed). */
export function peekLatency(correlationId: string): ExecutionLatency | undefined {
  return map.get(correlationId)?.latency;
}

/** Take and remove (the run is fully observed; the entry has served its purpose). */
export function takeLatency(correlationId: string): ExecutionLatency | undefined {
  const entry = map.get(correlationId);
  if (entry !== undefined) {
    map.delete(correlationId);
  }
  return entry?.latency;
}

/** Test hook: drop everything. */
export function clearLatencyMap(): void {
  map.clear();
}
