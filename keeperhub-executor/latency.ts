import { randomBytes } from "node:crypto";

import { logInfo } from "../lib/logging";

/**
 * End-to-end execution latency instrumentation (issue #2289).
 *
 * Every trigger message that reaches the executor gets a correlation id and a
 * set of stage timestamps as it moves through the pipeline:
 *
 *   observed   - the triggering event was first seen by the event-tracker
 *                 (epoch ms carried on the SQS message; absent for legacy
 *                 messages and non-event triggers)
 *   received   - SQS message arrived at the executor (processMessage)
 *   started    - workflow engine actually began running the workflow
 *   dispatched - dispatch handed the execution to its target
 *   broadcast  - a web3 write was broadcast (wired by write actions)
 *   completed  - execution reached a terminal state
 *
 * Stages are recorded once (idempotent), so a retried/recovered path can never
 * overwrite the first observation. Durations are derived from the recorded
 * marks rather than stored, keeping the class a pure observer.
 *
 * The `emitLatencyLog` helper in index.ts / in-process.ts emits the canonical
 * structured line (via lib/logging logInfo) carrying the correlation id and
 * per-stage timestamps, so a run is traceable across tracker, executor and
 * runner pod logs. Histogram samples go through the collector's recordLatency
 * surface, labeled by stage/trigger/target only - never by correlation id.
 */

export type LatencyStage =
  | "observed"
  | "received"
  | "started"
  | "dispatched"
  | "broadcast"
  | "completed";

// Canonical order for the emitted JSON. Stages may be skipped (e.g. an
// in-process run never broadcasts); ordering only applies to what is marked.
const STAGE_ORDER: readonly LatencyStage[] = [
  "observed",
  "received",
  "started",
  "dispatched",
  "broadcast",
  "completed",
];

/**
 * 16 hex chars from a CSPRNG. Unique enough to correlate a single execution
 * across systems via logs and the KH_CORRELATION_ID env var. Deliberately NOT
 * used as a metric label: a fresh value per execution would create one time
 * series per run (#2289 rules out even per-workflow labels as a metrics-cost
 * problem). It travels in the structured log lines instead, where it already
 * joins the tracker, executor and runner on one key. No dependency beyond
 * node:crypto.
 */
export function generateCorrelationId(): string {
  return randomBytes(8).toString("hex");
}

export class ExecutionLatency {
  readonly correlationId: string;
  private readonly marks = new Map<LatencyStage, number>();

  constructor(correlationId: string = generateCorrelationId()) {
    this.correlationId = correlationId;
  }

  /** Record a stage at the given epoch ms. First mark wins; later calls no-op. */
  mark(stage: LatencyStage, at: number = Date.now()): void {
    if (!this.marks.has(stage)) {
      this.marks.set(stage, at);
    }
  }

  has(stage: LatencyStage): boolean {
    return this.marks.has(stage);
  }

  at(stage: LatencyStage): number | undefined {
    return this.marks.get(stage);
  }

  /** received -> completed, or undefined until the run has finished. */
  totalMs(): number | undefined {
    const from = this.marks.get("received");
    const to = this.marks.get("completed");
    if (from === undefined || to === undefined) return undefined;
    return Math.max(0, to - from);
  }

  /** Duration between two stages; undefined unless both are marked. */
  stageMs(from: LatencyStage, to: LatencyStage): number | undefined {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    if (a === undefined || b === undefined) return undefined;
    return Math.max(0, b - a);
  }

  /**
   * JSON-safe field object for log emission. Only marked stages appear; each
   * timestamp is an ISO string. Durations are milliseconds.
   */
  toLogFields(): Record<string, string | number | undefined> {
    const fields: Record<string, string | number | undefined> = {
      correlationId: this.correlationId,
    };
    for (const stage of STAGE_ORDER) {
      const at = this.marks.get(stage);
      if (at !== undefined) {
        fields[`${stage}At`] = new Date(at).toISOString();
      }
    }
    const queueToStart = this.stageMs("received", "started");
    if (queueToStart !== undefined) fields.queueToStartMs = queueToStart;
    const total = this.totalMs();
    if (total !== undefined) fields.totalMs = total;
    return fields;
  }

  /**
   * The interval #2289 exists for: trigger observed by the tracker to the
   * transaction actually broadcast to the chain. Undefined until both stages
   * are marked (legacy messages have no `observed`; non-write runs never
   * broadcast).
   */
  broadcastMs(): number | undefined {
    return this.stageMs("observed", "broadcast");
  }

  /**
   * Emit the canonical structured latency line for this run via logInfo
   * (lib/logging). The correlation id rides as a label so tracker, executor
   * and runner logs join on one key; stage timestamps and derived durations
   * ride as extra fields. Deliberately NOT mirrored into metric labels - a
   * fresh id per execution would create one time series per run.
   */
  emitLog(params: {
    workflowId: string;
    executionId: string;
    triggerType: string;
    dispatchTarget: string;
  }): void {
    const { workflowId, executionId, triggerType, dispatchTarget } = params;
    const labels: Record<string, string> = {
      component: "executor_latency",
      correlation_id: this.correlationId,
      workflow_id: workflowId,
      execution_id: executionId,
      trigger_type: triggerType,
      dispatch_target: dispatchTarget,
    };
    const extras: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.toLogFields())) {
      if (key !== "correlationId" && value !== undefined) {
        extras[key] = String(value);
      }
    }
    const obsToBroadcast = this.broadcastMs();
    if (obsToBroadcast !== undefined) {
      extras.observed_to_broadcast_ms = String(obsToBroadcast);
    }
    logInfo("execution latency stages", { ...labels, ...extras });
  }
}