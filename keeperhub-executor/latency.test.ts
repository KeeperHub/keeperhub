import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionLatency,
  generateCorrelationId,
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
    expect(latency.broadcastMs()).toBeUndefined(); // never broadcast
    latency.mark("broadcast", 4_250);
    expect(latency.broadcastMs()).toBe(3_250);
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