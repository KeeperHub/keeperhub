/**
 * Latency observations from a workflow-runner pod (issue #2289).
 *
 * Ephemeral Job pods cannot write into the executor's Prometheus histograms
 * (histogram observations cannot be merged across pods without losing bucket
 * fidelity - see metrics-shipping.ts). What a pod CAN ship is point
 * observations: one duration per stage interval, labeled per-run. The
 * executor maps them back onto its central histograms via the ingest
 * endpoint, so k8s-job dispatches fill the same distributions in-process runs
 * do.
 *
 * Two intervals per run:
 *  - observed-broadcast    the headline #2289 measurement, from the tracker's
 *                          observedAt (carried in KH_OBSERVED_AT) to the
 *                          broadcast timestamp the write path dropped in the
 *                          sidecar marker. Absent for legacy messages without
 *                          observedAt, and for runs that never broadcast.
 *  - received-completed    the pod's own lifetime, from KH_RECEIVED_AT to
 *                          engine completion. The executor records it into
 *                          executor.execution.latency_ms with
 *                          stage="completed" (its own received timestamp is
 *                          authoritative for the start point, so a skewed pod
 *                          clock cannot distort the queue leg).
 *
 * Best-effort: absent env markers or an unreadable sidecar simply yield no
 * observation for that interval.
 */

import { takeBroadcastMarker } from "./broadcast-marker";

export type LatencyObservationStage =
  | "observed-broadcast"
  | "received-completed";

export type PendingObservation = {
  correlationId: string;
  executionId: string;
  workflowId: string;
  triggerType: string;
  dispatchTarget: string;
  stage: LatencyObservationStage;
  durationMs: number;
};

/** The correlation id the executor injected on the Job (k8s-job.ts). */
function runnerCorrelationId(): string {
  return process.env.KH_CORRELATION_ID ?? "";
}

/**
 * Collect the run's latency observations after executeWorkflow returns.
 * Returns an empty list when nothing was measurable (no correlation id, no
 * broadcast, or an unreadable sidecar) - shipping nothing is always valid.
 */
export function collectLatencyObservations(params: {
  executionId: string;
  workflowId: string;
  triggerType: string;
  /** Epoch ms the executor received the SQS message (KH_RECEIVED_AT). */
  receivedAt: number | undefined;
  /** Epoch ms the tracker first observed the event (KH_OBSERVED_AT). */
  observedAt: number | undefined;
  /** Epoch ms the engine reached its terminal state. */
  completedAt: number;
}): PendingObservation[] {
  const { executionId, workflowId, triggerType, receivedAt, observedAt, completedAt } =
    params;
  const correlationId = runnerCorrelationId();
  if (!correlationId) {
    return [];
  }

  const observations: PendingObservation[] = [];

  const marker = takeBroadcastMarker();
  if (marker && marker.executionId === executionId && observedAt !== undefined) {
    const durationMs = marker.broadcastAt - observedAt;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      observations.push({
        correlationId,
        executionId,
        workflowId,
        triggerType,
        dispatchTarget: "k8s-job",
        stage: "observed-broadcast",
        durationMs,
      });
    }
  }

  if (receivedAt !== undefined) {
    const durationMs = completedAt - receivedAt;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      observations.push({
        correlationId,
        executionId,
        workflowId,
        triggerType,
        dispatchTarget: "k8s-job",
        stage: "received-completed",
        durationMs,
      });
    }
  }

  return observations;
}
