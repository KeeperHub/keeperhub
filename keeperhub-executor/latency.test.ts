import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionLatency,
  generateCorrelationId,
  isRepresentableEpochMs,
} from "./latency";
import { executorMessageSchema } from "./message-schema";
import { logInfo } from "../lib/logging";
import { LabelKeys, MetricNames } from "../lib/metrics/types";

vi.mock("../lib/logging", () => ({ logInfo: vi.fn() }));

const logInfoMock = vi.mocked(logInfo);

beforeEach(() => {
  logInfoMock.mockClear();
});

describe("generateCorrelationId", () => {
  it("returns a 16-hex-char id", () => {
    for (let i = 0; i < 10; i++) {
      expect(generateCorrelationId()).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("does not collide across calls", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(seen.size).toBe(100);
  });
});

describe("ExecutionLatency", () => {
  it("defaults to a generated correlation id", () => {
    expect(new ExecutionLatency().correlationId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("accepts an explicit correlation id", () => {
    expect(new ExecutionLatency("abc123").correlationId).toBe("abc123");
  });

  it("records a stage and reports it via at/has", () => {
    const latency = new ExecutionLatency();
    latency.mark("received", 1000);
    expect(latency.has("received")).toBe(true);
    expect(latency.has("started")).toBe(false);
    expect(latency.at("received")).toBe(1000);
    expect(latency.at("started")).toBeUndefined();
  });

  it("is idempotent: the first mark wins", () => {
    const latency = new ExecutionLatency();
    latency.mark("received", 1000);
    latency.mark("received", 9999); // later, must not overwrite
    expect(latency.at("received")).toBe(1000);
  });

  it("computes stage durations between marked stages", () => {
    const latency = new ExecutionLatency();
    latency.mark("received", 100);
    latency.mark("started", 350);
    expect(latency.stageMs("received", "started")).toBe(250);
    // Missing endpoint -> undefined, never a negative or fabricated number.
    expect(latency.stageMs("started", "completed")).toBeUndefined();
    expect(latency.stageMs("received", "received")).toBe(0);
  });

  it("exposes totalMs only once completed", () => {
    const latency = new ExecutionLatency();
    latency.mark("received", 100);
    latency.mark("started", 350);
    expect(latency.totalMs()).toBeUndefined();
    latency.mark("completed", 1350);
    expect(latency.totalMs()).toBe(1250);
  });

  it("serializes only marked stages to log fields", () => {
    const latency = new ExecutionLatency("corr-1");
    latency.mark("received", 0);
    latency.mark("started", 100);
    latency.mark("completed", 500);

    const fields = latency.toLogFields();
    expect(fields.correlationId).toBe("corr-1");
    expect(fields.receivedAt).toBe(new Date(0).toISOString());
    expect(fields.startedAt).toBe(new Date(100).toISOString());
    expect(fields.completedAt).toBe(new Date(500).toISOString());
    expect(fields.broadcastAt).toBeUndefined();
    expect(fields.queueToStartMs).toBe(100);
    expect(fields.totalMs).toBe(500);
    // The whole object is JSON-safe (no undefined values leak into output).
    expect(JSON.parse(JSON.stringify(fields))).toEqual(
      expect.objectContaining({
        correlationId: "corr-1",
        queueToStartMs: 100,
        totalMs: 500,
      })
    );
  });

  it("emits the canonical structured latency line via logInfo", () => {
    const latency = new ExecutionLatency("corr-1");
    latency.mark("received", 0);
    latency.mark("started", 50);
    latency.mark("completed", 200);

    latency.emitLog({
      workflowId: "wf-1",
      executionId: "exec-1",
      triggerType: "event",
      dispatchTarget: "in-process",
    });

    expect(logInfoMock).toHaveBeenCalledTimes(1);
    const [message, labels] = logInfoMock.mock.calls[0];
    expect(message).toBe("execution latency stages");
    expect(labels).toMatchObject({
      component: "executor_latency",
      correlation_id: "corr-1",
      workflow_id: "wf-1",
      execution_id: "exec-1",
      trigger_type: "event",
      dispatch_target: "in-process",
      receivedAt: new Date(0).toISOString(),
      startedAt: new Date(50).toISOString(),
      completedAt: new Date(200).toISOString(),
      queueToStartMs: "50",
      totalMs: "200",
    });
  });

  it("carries the observed -> broadcast duration in the log line", () => {
    const latency = new ExecutionLatency("corr-obs");
    latency.mark("observed", 0);
    latency.mark("received", 100);
    latency.mark("started", 200);
    latency.mark("broadcast", 250);
    latency.mark("completed", 300);

    latency.emitLog({
      workflowId: "wf-1",
      executionId: "exec-1",
      triggerType: "event",
      dispatchTarget: "in-process",
    });

    const [, labels] = logInfoMock.mock.calls[0];
    expect(labels).toMatchObject({
      observedAt: new Date(0).toISOString(),
      broadcastAt: new Date(250).toISOString(),
      observed_to_broadcast_ms: "250",
    });
    // Stage ordering follows STAGE_ORDER.
    const keys = Object.keys(labels ?? {});
    expect(keys.indexOf("observedAt")).toBeLessThan(keys.indexOf("receivedAt"));
    expect(keys.indexOf("receivedAt")).toBeLessThan(keys.indexOf("broadcastAt"));
  });

  it("derives the #2289 observed -> broadcast interval only when both are marked", () => {
    const latency = new ExecutionLatency();
    latency.mark("observed", 1_000);
    expect(latency.rawStageMs("observed", "broadcast")).toBeUndefined(); // never broadcast
    latency.mark("broadcast", 4_250);
    expect(latency.rawStageMs("observed", "broadcast")).toBe(3_250);
  });

  it("emits no observed_to_broadcast_ms for a skewed clock, matching the histogram", () => {
    // A tracker clock running ahead of the executor stamps observed after
    // broadcast in wall-clock terms, so the raw delta is negative. The
    // recording sites drop it (the rawStageMs guard) and the log must agree:
    // with the clamped stageMs() the log said 0 ms for exactly the run whose
    // sample was dropped, and the two disagreed on the skew case.
    const latency = new ExecutionLatency("corr-skew");
    latency.mark("observed", 2_000);
    latency.mark("broadcast", 1_500); // 500 ms before "observed"

    expect(latency.rawStageMs("observed", "broadcast")).toBe(-500);
    expect(latency.stageMs("observed", "broadcast")).toBe(0); // clamped

    latency.emitLog({
      workflowId: "wf-1",
      executionId: "exec-1",
      triggerType: "event",
      dispatchTarget: "in-process",
    });

    const [, labels] = logInfoMock.mock.calls[0];
    expect(labels?.observed_to_broadcast_ms).toBeUndefined();
    // Both stamps are still individually present and valid.
    expect(labels?.observedAt).toBe(new Date(2_000).toISOString());
    expect(labels?.broadcastAt).toBe(new Date(1_500).toISOString());
  });

  it("keeps the ordering contract: skipped stages are simply absent", () => {
    const latency = new ExecutionLatency();
    latency.mark("received", 0);
    latency.mark("completed", 100);
    const fields = latency.toLogFields();
    expect(fields.startedAt).toBeUndefined();
    expect(fields.totalMs).toBe(100);
  });

  it("tracks the tracker-observed stage and derives the queue leg", () => {
    const latency = new ExecutionLatency("tracker-minted-id");
    // The tracker mints the id and stamps observedAt; the executor reuses the
    // id (issue #2289) and marks observed from the message field.
    latency.mark("observed", 1_000);
    latency.mark("received", 1_500);
    latency.mark("started", 1_700);
    latency.mark("completed", 2_500);

    expect(latency.stageMs("observed", "received")).toBe(500); // queue leg
    expect(latency.stageMs("received", "started")).toBe(200); // pre-engine
    // totalMs is the executor lifetime (received -> completed); the full
    // tracker-to-terminal pipeline is observed -> completed.
    expect(latency.totalMs()).toBe(1_000);
    expect(latency.stageMs("observed", "completed")).toBe(1_500);

    const fields = latency.toLogFields();
    expect(fields.correlationId).toBe("tracker-minted-id");
    expect(fields.observedAt).toBe(new Date(1_000).toISOString());
  });

  it("emits observed before received in the log line", () => {
    const latency = new ExecutionLatency("corr-obs");
    latency.mark("observed", 0);
    latency.mark("received", 100);
    latency.mark("started", 200);
    latency.mark("completed", 300);

    latency.emitLog({
      workflowId: "wf-1",
      executionId: "exec-1",
      triggerType: "event",
      dispatchTarget: "in-process",
    });

    const [, labels] = logInfoMock.mock.calls[0];
    const keys = Object.keys(labels ?? {});
    expect(keys.indexOf("observedAt")).toBeLessThan(keys.indexOf("receivedAt"));
    expect(labels).toMatchObject({ correlation_id: "corr-obs" });
  });
});

// Drift guards: the wiring in index.ts / in-process.ts references these exact
// constants. If they are renamed or dropped, these tests fail at compile time.
describe("latency metric constants", () => {
  it("exposes the executor latency metric names", () => {
    expect(MetricNames.EXECUTOR_DISPATCH_LATENCY).toBe("executor.dispatch.latency_ms");
    expect(MetricNames.EXECUTOR_EXECUTION_LATENCY).toBe("executor.execution.latency_ms");
    expect(MetricNames.EXECUTOR_BROADCAST_LATENCY).toBe("executor.broadcast.latency_ms");
  });

  it("exposes the dispatch/stage labels and no correlation-id label", () => {
    expect(LabelKeys.DISPATCH_TARGET).toBe("dispatch_target");
    expect(LabelKeys.STAGE).toBe("stage");
    // The correlation id must never be a metric label (one time series per
    // execution); it lives in logs and KH_CORRELATION_ID only.
    expect(Object.values(LabelKeys)).not.toContain("correlation_id");
  });
});

// The invariant this PR states for itself: observability must not be able to
// fail a transaction. `new Date(1e16).toISOString()` throws RangeError, and
// 1e16 is a plain finite JSON number every layer upstream accepts - so a
// producer emitting microseconds reached the throw. On the in-process path it
// landed in executeInProcess's catch and wrote status "error" for a run that
// succeeded. These pin the guard that makes that impossible.
describe("latency observation guards", () => {
  const UNREPRESENTABLE = 1e16;
  const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

  it("drops a stamp the Date constructor cannot represent", () => {
    const latency = new ExecutionLatency("corr-guard");
    expect(() => latency.mark("observed", UNREPRESENTABLE)).not.toThrow();
    expect(latency.has("observed")).toBe(false);
    expect(latency.at("observed")).toBeUndefined();
  });

  it("keeps a stamp at the edge of the representable window", () => {
    const latency = new ExecutionLatency("corr-guard");
    latency.mark("observed", MAX_DATE_EPOCH_MS);
    expect(latency.toLogFields().observedAt).toBe(
      new Date(MAX_DATE_EPOCH_MS).toISOString()
    );
  });

  it("records no observed -> broadcast leg for a dropped stamp", () => {
    const latency = new ExecutionLatency("corr-guard");
    latency.mark("observed", UNREPRESENTABLE);
    latency.mark("broadcast", 5_000);
    // Absent, not fabricated: a stripped stamp must not surface as a 0ms leg.
    expect(latency.rawStageMs("observed", "broadcast")).toBeUndefined();
  });

  it("emits the log line without throwing on a dropped stamp", () => {
    const latency = new ExecutionLatency("corr-guard");
    latency.mark("observed", UNREPRESENTABLE);
    latency.mark("received", 100);
    latency.mark("completed", 200);

    expect(() =>
      latency.emitLog({
        workflowId: "wf-1",
        executionId: "exec-1",
        triggerType: "event",
        dispatchTarget: "k8s-job",
      })
    ).not.toThrow();

    const [, labels] = logInfoMock.mock.calls[0];
    expect(labels).toMatchObject({ correlation_id: "corr-guard" });
    expect(labels?.observedAt).toBeUndefined();
    expect(labels?.observed_to_broadcast_ms).toBeUndefined();
  });

  it("replaces a correlation id that cannot be a Kubernetes label value", () => {
    // A 64-char value, a slash, a leading dash and an empty string all fail
    // Job creation (k8s-job.ts writes the id into the Job's labels).
    for (const unsafe of ["a".repeat(64), "bad/id", "-leading", ""]) {
      expect(new ExecutionLatency(unsafe).correlationId).toMatch(
        /^[0-9a-f]{16}$/
      );
    }
  });

  it("keeps a correlation id that is safe as a label value", () => {
    expect(new ExecutionLatency("abcd1234efgh5678").correlationId).toBe(
      "abcd1234efgh5678"
    );
  });
});

describe("event message schema with latency correlation", () => {
  it("accepts an event message carrying correlationId + observedAt", () => {
    const parsed = executorMessageSchema.safeParse({
      triggerType: "event",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: { eventName: "Transfer" },
      correlationId: "abcd1234efgh5678",
      observedAt: 123456789,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts legacy event messages without the correlation fields", () => {
    const parsed = executorMessageSchema.safeParse({
      triggerType: "event",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: { eventName: "Transfer" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a microsecond-scale observedAt (guards the producer contract)", () => {
    // 1e16 is a plain finite JSON number: nothing upstream rejects it, and
    // `new Date(1e16).toISOString()` throws RangeError downstream.
    const parsed = executorMessageSchema.safeParse({
      triggerType: "event",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: {},
      observedAt: 1e16,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a fractional observedAt", () => {
    const parsed = executorMessageSchema.safeParse({
      triggerType: "event",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: {},
      observedAt: 1_000.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a correlationId that cannot be a Kubernetes label value", () => {
    for (const correlationId of ["a".repeat(64), "bad/id"]) {
      const parsed = executorMessageSchema.safeParse({
        triggerType: "event",
        workflowId: "wf-1",
        userId: "u-1",
        triggerData: {},
        correlationId,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects a malformed observedAt (guards the producer contract)", () => {
    const parsed = executorMessageSchema.safeParse({
      triggerType: "event",
      workflowId: "wf-1",
      userId: "u-1",
      triggerData: {},
      observedAt: "not-a-number",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("latency stage arithmetic (issue #2289 review)", () => {
  it("rejects a negative epoch stamp", () => {
    // No epoch-ms timestamp predates 1970. `Math.abs` alone admitted -1e15,
    // which passed the schema in `warn` mode and then derived a ~1e15 ms
    // observed->broadcast interval, polluting that label set's `_sum` until the
    // pod restarted.
    expect(isRepresentableEpochMs(-1)).toBe(false);
    expect(isRepresentableEpochMs(-1e15)).toBe(false);
    expect(isRepresentableEpochMs(1.5)).toBe(false);
    expect(isRepresentableEpochMs(8_640_000_000_000_001)).toBe(false);
    expect(isRepresentableEpochMs(0)).toBe(true);
  });

  it("drops a negative stamp rather than storing it", () => {
    const latency = new ExecutionLatency("corr-negative");
    latency.mark("observed", -1e15);
    expect(latency.at("observed")).toBeUndefined();
    expect(latency.has("observed")).toBe(false);
  });

  it("keeps the raw delta negative where stageMs clamps it to zero", () => {
    // observed is stamped by the tracker pod and broadcast by the executor, so a
    // tracker clock running ahead yields a negative delta. Recording the clamped
    // value would be a fabricated 0 ms sample, and the k8s-job series drops a
    // negative interval for the same skew - so the two series in one histogram
    // would disagree on `_count`.
    const latency = new ExecutionLatency("corr-skew");
    latency.mark("observed", 2_000);
    latency.mark("broadcast", 1_500);
    expect(latency.stageMs("observed", "broadcast")).toBe(0);
    expect(latency.rawStageMs("observed", "broadcast")).toBe(-500);
  });

  it("rawStageMs agrees with stageMs when the stages are in order", () => {
    const latency = new ExecutionLatency("corr-in-order");
    latency.mark("observed", 2_000);
    latency.mark("broadcast", 2_500);
    expect(latency.rawStageMs("observed", "broadcast")).toBe(500);
    expect(latency.stageMs("observed", "broadcast")).toBe(500);
  });

  it("rawStageMs is undefined unless both stages are marked", () => {
    const latency = new ExecutionLatency("corr-partial");
    latency.mark("observed", 2_000);
    expect(latency.rawStageMs("observed", "broadcast")).toBeUndefined();
  });
});