import { beforeEach, describe, expect, it, vi } from "vitest";

// The applier reads the collector through lib/metrics; stub the collector so
// samples can be asserted without a registry.
const recordLatencyMock = vi.fn();
vi.mock("../../lib/metrics", () => ({
  getMetricsCollector: () => ({ recordLatency: recordLatencyMock }),
}));

// Server-only guard stub (metrics/types imports are type-only, but the
// registry module chain may carry the marker).
vi.mock("server-only", () => ({}));

const { applyObservations } = await import("./observation-applier");
const { trackLatency, peekLatency, clearLatencyMap } = await import(
  "./correlation-map"
);
const { ExecutionLatency } = await import("../latency");
const { MetricNames, LabelKeys } = await import("../../lib/metrics/types");

beforeEach(() => {
  recordLatencyMock.mockClear();
  clearLatencyMap();
});

const BASE = {
  correlationId: "corr-1",
  executionId: "exec-1",
  workflowId: "wf-1",
  triggerType: "event",
  dispatchTarget: "k8s-job",
};

describe("applyObservations", () => {
  it("records observed-broadcast even when the correlation entry is gone", () => {
    const { applied, skipped } = applyObservations([
      { ...BASE, stage: "observed-broadcast", durationMs: 4200 },
    ]);
    expect(applied).toBe(1);
    expect(skipped).toBe(0);
    expect(recordLatencyMock).toHaveBeenCalledWith(
      MetricNames.EXECUTOR_BROADCAST_LATENCY,
      4200,
      {
        [LabelKeys.TRIGGER_TYPE]: "event",
        [LabelKeys.DISPATCH_TARGET]: "k8s-job",
      }
    );
  });

  it("marks the tracked timeline broadcast and records the sample", () => {
    const latency = new ExecutionLatency("corr-2");
    latency.mark("observed", 1000);
    trackLatency(latency);
    applyObservations([
      { ...BASE, correlationId: "corr-2", stage: "observed-broadcast", durationMs: 2500 },
    ]);
    expect(latency.has("broadcast")).toBe(true);
    expect(latency.broadcastMs()).toBe(2500);
  });

  it("anchors received-completed on the executor's received stamp", () => {
    const latency = new ExecutionLatency("corr-3");
    latency.mark("received", 10_000);
    trackLatency(latency);
    const { applied } = applyObservations([
      { ...BASE, correlationId: "corr-3", stage: "received-completed", durationMs: 6400 },
    ]);
    expect(applied).toBe(1);
    // completion = received + pod-reported duration; totalMs derived there.
    expect(latency.totalMs()).toBe(6400);
    expect(recordLatencyMock).toHaveBeenCalledWith(
      MetricNames.EXECUTOR_EXECUTION_LATENCY,
      6400,
      expect.objectContaining({ stage: "completed" })
    );
    // The timeline is fully observed: the correlation entry was freed.
    expect(peekLatency("corr-3")).toBeUndefined();
  });

  it("skips received-completed with no tracked timeline (executor restarted)", () => {
    const { applied, skipped } = applyObservations([
      { ...BASE, correlationId: "ghost", stage: "received-completed", durationMs: 100 },
    ]);
    expect(applied).toBe(0);
    expect(skipped).toBe(1);
    expect(recordLatencyMock).not.toHaveBeenCalled();
  });

  it("counts mixed batches correctly", () => {
    const latency = new ExecutionLatency("corr-4");
    latency.mark("received", 5_000);
    trackLatency(latency);
    const { applied, skipped } = applyObservations([
      { ...BASE, correlationId: "corr-unknown", stage: "observed-broadcast", durationMs: 800 },
      { ...BASE, correlationId: "corr-4", stage: "received-completed", durationMs: 1200 },
      { ...BASE, correlationId: "corr-ghost2", stage: "received-completed", durationMs: 300 },
    ]);
    expect(applied).toBe(2);
    expect(skipped).toBe(1);
  });
});
