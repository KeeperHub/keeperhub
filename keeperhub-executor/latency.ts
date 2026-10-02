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

/**
 * The largest epoch-ms stamp the platform can render as a Date, and the lower
 * bound an epoch can have at all. `new Date(ms)` is valid for |ms| <= 8.64e15
 * and `toISOString()` throws RangeError outside that window - a producer
 * emitting microseconds (1e16) is a plain finite JSON number that lands there.
 * Negative stamps are rejected too: no epoch-ms timestamp predates 1970, so a
 * negative value is a corrupt or hostile producer rather than a real time, and
 * `Math.abs` alone would have admitted `-1e15` and derived a ~1e15 ms interval
 * from it into the broadcast histogram, polluting that label set's `_sum` until
 * the pod restarts. One definition shared by the message schema (the producer
 * contract) and the consumers (the guard that stops a bad stamp from failing a
 * run): observability must not be able to fail a transaction.
 */
export const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export function isRepresentableEpochMs(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_EPOCH_MS
  );
}

/** ISO-8601 for a stamp, or undefined when it is outside that window. */
function toIsoString(at: number): string | undefined {
  return isRepresentableEpochMs(at) ? new Date(at).toISOString() : undefined;
}

/**
 * A correlation id that is safe everywhere it travels: the "correlation-id"
 * label on the runner's Job (a Kubernetes label value caps at 63 characters,
 * must start and end alphanumeric, and admits only [A-Za-z0-9_.-] in between),
 * the KH_CORRELATION_ID env var and the structured log line.
 * generateCorrelationId() mints 16 hex chars, well inside this; the allowlist
 * exists for ids reused from the trigger message, which a producer supplies.
 * Defined once so the label, the env var and the logs stay in step.
 */
export const SAFE_CORRELATION_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

export function isSafeCorrelationId(value: string): boolean {
  return SAFE_CORRELATION_ID.test(value);
}

export class ExecutionLatency {
  readonly correlationId: string;
  private readonly marks = new Map<LatencyStage, number>();

  /**
   * An id that cannot be used where it is carried - absent, or not a valid
   * Kubernetes label value - is discarded in favour of a locally minted one,
   * exactly as if the message had not carried one. The id is pure
   * observability metadata and it is written straight into the runner Job's
   * metadata labels (k8s-job.ts), where an over-long or slash-bearing value
   * fails Job creation, turning a bad correlation id into a workflow that
   * never runs. Falling back keeps the run, keeps the label valid and keeps
   * the logs joinable on a local id.
   */
  constructor(correlationId?: string) {
    this.correlationId =
      correlationId !== undefined && isSafeCorrelationId(correlationId)
        ? correlationId
        : generateCorrelationId();
  }

  /**
   * Record a stage at the given epoch ms. First mark wins; later calls no-op.
   *
   * A stamp the platform cannot represent as a Date is dropped rather than
   * stored. Stage timestamps are rendered with `new Date(at).toISOString()` in
   * toLogFields, which throws RangeError outside the representable window (a
   * producer emitting microseconds, 1e16, lands there). On the in-process path
   * that throw lands in executeInProcess's catch and writes status "error" for
   * a run that succeeded; on the k8s-job path it lands after the Job is already
   * created. An unusable stamp costs the observation, never the transaction,
   * and a run with no observed stamp simply records no observed->broadcast
   * interval instead of a fabricated zero.
   */
  mark(stage: LatencyStage, at: number = Date.now()): void {
    if (!isRepresentableEpochMs(at)) {
      return;
    }
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
   * Duration between two stages *without* clamping, or undefined unless both
   * are marked. stageMs() exists for rendering, where a negative interval is
   * meaningless and 0 is the friendlier output. Recording is the other case:
   * `observed` is stamped by the event-tracker pod and `broadcast` by the
   * executor pod, so a tracker clock running ahead produces a negative raw
   * delta that has to be dropped rather than reported as a real-looking 0 ms.
   * latency-observations.ts already discards a negative interval for the
   * k8s-job series, and clamping here instead would make the two series in one
   * histogram disagree on `_count` for the same skew.
   */
  rawStageMs(from: LatencyStage, to: LatencyStage): number | undefined {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    if (a === undefined || b === undefined) return undefined;
    return b - a;
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
        const iso = toIsoString(at);
        if (iso !== undefined) {
          fields[`${stage}At`] = iso;
        }
      }
    }
    const queueToStart = this.stageMs("received", "started");
    if (queueToStart !== undefined) fields.queueToStartMs = queueToStart;
    const total = this.totalMs();
    if (total !== undefined) fields.totalMs = total;
    return fields;
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
    const obsToBroadcast = this.rawStageMs("observed", "broadcast");
    if (obsToBroadcast !== undefined && obsToBroadcast >= 0) {
      // Raw, non-negative delta - the same guard the recording sites apply
      // before writing a sample. A skewed run logs no interval at all,
      // matching the histogram that (correctly) has no sample; with the
      // clamped stageMs() the log said 0 ms for exactly the run whose sample
      // was dropped, and the two disagreed on the skew case.
      extras.observed_to_broadcast_ms = String(obsToBroadcast);
    }
    logInfo("execution latency stages", { ...labels, ...extras });
  }
}
