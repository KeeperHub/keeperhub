import { randomBytes } from "node:crypto";

/**
 * End-to-end execution latency instrumentation (issue #2289).
 *
 * Every trigger message that reaches the executor gets a correlation id and a
 * set of stage timestamps as it moves through the pipeline:
 *
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
 * The `recordExecutionLatency` helper emits BOTH a structured log line (so the
 * correlation id and per-stage timestamps land in Loki / CloudWatch and a run
 * can be traced across executor, runner pod and API) AND a histogram sample via
 * the collector's existing recordLatency surface.
 */

export type LatencyStage =
  | "received"
  | "started"
  | "dispatched"
  | "broadcast"
  | "completed";

// Canonical order for the emitted JSON. Stages may be skipped (e.g. an
// in-process run never broadcasts); ordering only applies to what is marked.
const STAGE_ORDER: readonly LatencyStage[] = [
  "received",
  "started",
  "dispatched",
  "broadcast",
  "completed",
];

/**
 * 16 hex chars from a CSPRNG. Short enough for labels and URLs, unique enough
 * to correlate a single execution across systems. No dependency beyond node:crypto.
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
   * Single-line structured summary matching the executor's JSON log shape
   * (`[Component] key=value ...`). Parsable with a plain key=value splitter.
   */
  summaryLine(params: {
    workflowId: string;
    executionId?: string;
    triggerType: string;
    dispatchTarget: string;
  }): string {
    const { workflowId, executionId, triggerType, dispatchTarget } = params;
    const fields = this.toLogFields();
    const parts = [
      "correlationId=" + this.correlationId,
      "workflowId=" + workflowId,
      "triggerType=" + triggerType,
      "dispatchTarget=" + dispatchTarget,
    ];
    if (executionId) parts.push("executionId=" + executionId);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) parts.push(`${key}=${value}`);
    }
    return `[Executor:Latency] ${parts.join(" ")}`;
  }
}