/**
 * Correlation-id lookup for latency observations (issue #2289).
 *
 * The executor creates an ExecutionLatency per SQS message, but the runner
 * pod's observations arrive asynchronously over the metrics ingest, after the
 * message handler has moved on. This bounded map lets the ingest applier find
 * the originating timeline by correlation id. Entries are removed when their
 * received-completed observation is applied; the cap keeps a pathological
 * ingest stream from growing the map without bound (oldest entries evicted -
 * they would be unusably stale anyway).
 */

import type { ExecutionLatency } from "../latency";

const MAX_TRACKED = 1024;

const map = new Map<string, ExecutionLatency>();

/** Track the timeline for a run from SQS receive until its observations land. */
export function trackLatency(latency: ExecutionLatency): void {
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(latency.correlationId, latency);
}

/** Peek without removing (observed-broadcast arrives before completed). */
export function peekLatency(correlationId: string): ExecutionLatency | undefined {
  return map.get(correlationId);
}

/** Take and remove (the run is fully observed; the entry has served its purpose). */
export function takeLatency(correlationId: string): ExecutionLatency | undefined {
  const latency = map.get(correlationId);
  if (latency !== undefined) {
    map.delete(correlationId);
  }
  return latency;
}

/** Test hook: drop everything. */
export function clearLatencyMap(): void {
  map.clear();
}
