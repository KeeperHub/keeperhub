/**
 * Executor-side applier for runner latency observations (issue #2289).
 *
 * Maps each observation back onto its ExecutionLatency via the correlation
 * map, marks the timeline (so per-run log lines carry the pod stages), and
 * records the point sample into the central histograms:
 *
 *  - observed-broadcast   -> executor.broadcast.latency_ms
 *                            (trigger observed -> transaction broadcast; the
 *                            interval #2289 asks the distribution of)
 *  - received-completed   -> the timeline's received stamp is authoritative
 *                            for the start point; the observation supplies
 *                            the completion offset, recorded into
 *                            executor.execution.latency_ms with
 *                            stage="completed"
 *
 * Registered with metrics-shipping via setLatencyObservationApplier, which
 * keeps this module (and its registry import) out of the runner bundle.
 * Observations whose correlation id is unknown (restarted executor, cap
 * eviction) are recorded into the histograms anyway when the stage interval
 * is self-contained, and skipped otherwise - a lost correlation must never
 * lose a measurable sample where it can still be placed.
 */

import { getMetricsCollector } from "../../lib/metrics";
import { LabelKeys, MetricNames } from "../../lib/metrics/types";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { peekLatency, takeLatency } from "./correlation-map";
import {
  setLatencyObservationApplier,
  type LatencyObservation,
} from "./metrics-shipping";

function recordSample(
  name: string,
  durationMs: number,
  labels: Record<string, string>
): void {
  getMetricsCollector().recordLatency(name, durationMs, labels);
}

export function applyObservations(
  observations: readonly LatencyObservation[]
): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;

  for (const o of observations) {
    // Per-observation isolation: the only thing in the loop that can throw is
    // the collector (recordLatency throws on an unregistered label). Without
    // this guard a throw on observation k answered the ingest with
    // obsApplied = 0 / obsSkipped = N even though 0..k-1 were recorded - and
    // anyone alerting on obsSkipped read a total failure for a partial one.
    // One bad observation now costs itself and the batch continues.
    try {
      if (applyOne(o)) {
        applied++;
      } else {
        skipped++;
      }
    } catch (error) {
      skipped++;
      // The outer catch in index.ts can no longer see a per-observation
      // throw (the loop body is inside this try), so without this the
      // failure is stdout-only. INFRASTRUCTURE, matching the outer catch's
      // category: a collector that rejects a registered label is a system
      // fault, not a caller's.
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        `[Executor] Latency observation ${o.stage} for correlation ${o.correlationId} failed to apply (skipped):`,
        error
      );
    }
  }

  return { applied, skipped };
}

/** Apply one observation; false means it was not placeable (skip, not error). */
function applyOne(o: LatencyObservation): boolean {
  const latency = peekLatency(o.correlationId);
  const labels = {
    [LabelKeys.TRIGGER_TYPE]: o.triggerType,
    [LabelKeys.DISPATCH_TARGET]: o.dispatchTarget,
  };

  if (o.stage === "observed-broadcast") {
    // Self-contained interval: the pod measured observedAt -> broadcast.
    // Even without the correlation entry the sample is placeable.
    recordSample(MetricNames.EXECUTOR_BROADCAST_LATENCY, o.durationMs, labels);
    // Reconstruct the broadcast epoch on the timeline so the per-run log
    // line carries the same interval the histogram recorded.
    const observedAt = latency?.at("observed");
    latency?.mark(
      "broadcast",
      observedAt !== undefined ? observedAt + o.durationMs : Date.now()
    );
    return true;
  }

  // received-completed: the executor's own received stamp anchors the
  // start, so only the completion offset is taken from the pod.
  if (!latency) {
    return false;
  }
  const receivedAt = latency.at("received");
  if (receivedAt === undefined) {
    return false;
  }
  latency.mark("completed", receivedAt + o.durationMs);
  const totalMs = latency.totalMs();
  if (totalMs === undefined) {
    return false;
  }
  recordSample(MetricNames.EXECUTOR_EXECUTION_LATENCY, totalMs, {
    ...labels,
    [LabelKeys.STAGE]: "completed",
  });
  takeLatency(o.correlationId); // timeline fully observed; free the entry
  return true;
}

/**
 * Wire the applier into the ingest path. Called once from index.ts startup.
 */
export function registerLatencyObservationApplier(): void {
  setLatencyObservationApplier(applyObservations);
}
