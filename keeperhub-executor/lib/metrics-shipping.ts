/**
 * Shared metric shipping contract between workflow-runner (producer) and
 * executor (aggregator).
 *
 * Ephemeral workflow-runner pods collect counter deltas from their in-process
 * Prometheus registry and POST them to the long-lived executor, which merges
 * them into its own registry. Prometheus then scrapes the executor.
 *
 * Only counters are shipped. Gauges carry state (not accumulations) and
 * histograms cannot be merged without losing bucket fidelity. RPC latency
 * histograms from Job pods are intentionally dropped; executor-native
 * workflows still record them directly.
 */

import type { Counter } from "prom-client";

export type MetricDelta = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

export type IngestPayload = {
  deltas: MetricDelta[];
};

async function loadShippableCounters(): Promise<
  Record<string, Counter<string>>
> {
  const { rpcMetrics, workflowCounterMetrics } = await import(
    "../../lib/metrics/collectors/prometheus"
  );
  return {
    keeperhub_rpc_primary_attempts_total: rpcMetrics.primaryAttempts,
    keeperhub_rpc_primary_failures_total: rpcMetrics.primaryFailures,
    keeperhub_rpc_fallback_attempts_total: rpcMetrics.fallbackAttempts,
    keeperhub_rpc_fallback_failures_total: rpcMetrics.fallbackFailures,
    keeperhub_rpc_failover_events_total: rpcMetrics.failoverEvents,
    keeperhub_rpc_recovery_events_total: rpcMetrics.recoveryEvents,
    keeperhub_rpc_both_failed_total: rpcMetrics.bothFailedEvents,
    keeperhub_rpc_errors_by_type_total: rpcMetrics.errorsByType,
    keeperhub_workflow_execution_errors_created_total:
      workflowCounterMetrics.executionErrorsCreated,
    keeperhub_workflow_executions_finished_total:
      workflowCounterMetrics.executionsFinished,
  };
}

export const SHIPPABLE_COUNTER_NAMES = [
  "keeperhub_rpc_primary_attempts_total",
  "keeperhub_rpc_primary_failures_total",
  "keeperhub_rpc_fallback_attempts_total",
  "keeperhub_rpc_fallback_failures_total",
  "keeperhub_rpc_failover_events_total",
  "keeperhub_rpc_recovery_events_total",
  "keeperhub_rpc_both_failed_total",
  "keeperhub_rpc_errors_by_type_total",
  "keeperhub_workflow_execution_errors_created_total",
  "keeperhub_workflow_executions_finished_total",
] as const;

export async function collectCounterDeltas(): Promise<MetricDelta[]> {
  const counters = await loadShippableCounters();
  const deltas: MetricDelta[] = [];

  for (const name of SHIPPABLE_COUNTER_NAMES) {
    const counter = counters[name];
    if (!counter) {
      continue;
    }
    const data = await counter.get();
    for (const entry of data.values) {
      if (entry.value > 0) {
        deltas.push({
          name,
          labels: normalizeLabels(entry.labels),
          value: entry.value,
        });
      }
    }
  }

  return deltas;
}

export async function applyCounterDeltas(
  deltas: readonly MetricDelta[]
): Promise<{ applied: number; skipped: number }> {
  const counters = await loadShippableCounters();
  let applied = 0;
  let skipped = 0;

  for (const delta of deltas) {
    const counter = counters[delta.name];
    const valid = counter && Number.isFinite(delta.value) && delta.value > 0;
    if (!valid) {
      skipped++;
      continue;
    }
    counter.inc(delta.labels, delta.value);
    applied++;
  }

  return { applied, skipped };
}

function normalizeLabels(
  labels: Partial<Record<string, string | number>> | undefined
): Record<string, string> {
  if (!labels) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}

export function isMetricDelta(value: unknown): value is MetricDelta {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const {
    name,
    labels,
    value: v,
  } = value as {
    name?: unknown;
    labels?: unknown;
    value?: unknown;
  };
  if (typeof name !== "string" || typeof v !== "number") {
    return false;
  }
  if (typeof labels !== "object" || labels === null) {
    return false;
  }
  for (const labelValue of Object.values(labels as Record<string, unknown>)) {
    if (typeof labelValue !== "string") {
      return false;
    }
  }
  return true;
}

export function isIngestPayload(value: unknown): value is IngestPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { deltas } = value as { deltas?: unknown };
  if (!Array.isArray(deltas)) {
    return false;
  }
  return deltas.every(isMetricDelta);
}
