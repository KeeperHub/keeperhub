/**
 * Correlation-id lookup for latency observations (issue #2289).
 *
 * The executor creates an ExecutionLatency per SQS message, but the runner
 * pod's observations arrive asynchronously over the metrics ingest, after the
 * message handler has moved on. This bounded map lets the ingest applier find
 * the originating timeline by correlation id.
 *
 * Entries are freed three ways, in order of normal frequency:
 *
 *  1. A k8s-job entry is taken when its received-completed observation lands
 *     (observation-applier.ts) - the ingest is the only thing that will ever
 *     observe that timeline, so the observation is the run end.
 *  2. An in-process entry is taken by executeInProcess in a finally at run
 *     end, and an api entry is taken right after its dispatch returns: those
 *     targets ship nothing to the ingest, so waiting for an observation that
 *     never comes held the slot for the map's whole turnover window. That was
 *     the leak: with only k8s-job entries freed, the ring turned over on
 *     message volume, and at 5 msg/s a Job run near the 300-second active
 *     deadline lost its entry before its own observation landed.
 *  3. Everything whose run never reaches one of those handlers - an
 *     auth-rejected or malformed message, a workflow not found, a billing
 *     refusal, a process killed mid-run - is reclaimed by the two bounds
 *     below. A process killed mid-run restarts with an empty map, so the
 *     bounds really cover the never-dispatched messages in a long-lived pod.
 */

import type { ExecutionLatency } from "../latency";

/**
 * Maximum entries held. Oldest-inserted is dropped only when a forced age
 * scan (below) found nothing stale to reclaim first. Exported for the cap
 * tests; production code should not branch on it.
 */
export const MAX_TRACKED = 1024;

/**
 * How long an entry from a never-dispatched run may sit before the age scan
 * drops it. Exported for the eviction test; production code should not
 * branch on it.
 *
 * An hour is deliberately far outside the range of any legitimate wait, in
 * both directions:
 *
 *  - Entries that wait for their observation belong to k8s-job runs, and that
 *    Job is bounded by `activeDeadlineSeconds` (CONFIG.jobActiveDeadline,
 *    300s by default) with the ingest landing moments after the run ends. An
 *    hour is therefore twelve times the longest wait the platform can
 *    produce - not a tuned threshold, but a bound nothing legitimate can
 *    approach.
 *  - Entries from never-dispatched runs (case 3 above) cost a held slot and
 *    nothing else, so reclaiming them lazily rather than eagerly is the
 *    conservative end: being slow costs a slot, being eager costs a real
 *    sample.
 *
 * One assumption, written down because it is invisible from here: if
 * `JOB_ACTIVE_DEADLINE` is raised far above its default, this bound has to
 * rise with it.
 */
export const MAX_TRACKED_AGE_MS = 60 * 60 * 1000;

/**
 * Minimum gap between full-map age scans. The scan sits behind trackLatency,
 * which runs for every SQS message, and after the run-end takes (cases 1 and
 * 2 above) there is normally nothing stale to find - a per-message full scan
 * was hot-path work in exactly the regime where it cannot help. Once per
 * interval is enough: an entry can outlive its bound by up to the interval,
 * and a held slot costs nothing at 1024-entry scale.
 */
const EVICT_SCAN_INTERVAL_MS = 60_000;

let lastEvictScanAt = 0;

const map = new Map<string, TrackedEntry>();

type TrackedEntry = {
  latency: ExecutionLatency;
  /** The run's own receive stamp, or the tracking time when it has none. */
  trackedAt: number;
};

/**
 * Drop entries older than MAX_TRACKED_AGE_MS, at most once per
 * EVICT_SCAN_INTERVAL_MS - unless `force` is set. The map is capped at 1024
 * entries, so a scan is bounded; the throttle keeps it off the per-message
 * path, and the cap lifts the throttle (trackLatency), because a full map is
 * exactly the moment the next insert must drop the oldest *inserted* entry -
 * which can be a k8s-job run still awaiting its observation. The cheap scan
 * is worth its cost precisely there.
 */
function evictStale(now: number, force = false): void {
  if (!force && now - lastEvictScanAt < EVICT_SCAN_INTERVAL_MS) {
    return;
  }
  lastEvictScanAt = now;
  for (const [id, entry] of map) {
    if (now - entry.trackedAt > MAX_TRACKED_AGE_MS) {
      map.delete(id);
    }
  }
}

/** Track the timeline for a run from SQS receive until its observations land. */
export function trackLatency(latency: ExecutionLatency): void {
  const now = Date.now();
  // At the cap the scan runs regardless of the throttle: between two
  // throttled scans a full map would otherwise drop the oldest inserted
  // entry, which can be a k8s-job run whose observation has not landed
  // yet, while a genuinely stale entry (a never-dispatched run from an
  // hour ago) keeps its slot. Scan first; only if nothing stale was found
  // does the arrival-order drop below reclaim a slot.
  evictStale(now, map.size >= MAX_TRACKED);
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

/** Test hook: drop everything, and reset the scan throttle so a test gets
 * first-call semantics for evictStale. */
export function clearLatencyMap(): void {
  map.clear();
  lastEvictScanAt = 0;
}
