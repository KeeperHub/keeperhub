import { describe, expect, it, vi } from "vitest";

// lib/metrics/collectors/prometheus.ts is server-only because it touches
// prom-client's process-global registries. Stub server-only so this test can
// load the module under vitest's node environment (same approach as
// error-labels.test.ts).
vi.mock("server-only", () => ({}));

const {
  prometheusMetricsCollector,
  getApiProcessMetrics,
} = await import("@/lib/metrics/collectors/prometheus");
const { MetricNames, LabelKeys } = await import("@/lib/metrics/types");

describe("executor latency histograms (issue #2289)", () => {
  it("records a dispatch sample without logging Unknown latency metric", async () => {
    // Registering the name in histogramMap is the whole point: before this,
    // every sample was discarded with "[Prometheus] Unknown latency metric".
    const samples = await prometheusMetricsCollector.recordLatency(
      MetricNames.EXECUTOR_DISPATCH_LATENCY,
      1234,
      {
        [LabelKeys.TRIGGER_TYPE]: "event",
        [LabelKeys.DISPATCH_TARGET]: "k8s-job",
        [LabelKeys.STAGE]: "dispatched",
      }
    );
    void samples;

    const metrics = await getApiProcessMetrics();
    expect(metrics).toContain("keeperhub_executor_dispatch_latency_ms");
    expect(metrics).toContain('trigger_type="event"');
    expect(metrics).toContain('dispatch_target="k8s-job"');
    expect(metrics).toContain('stage="dispatched"');
    // Exactly one observation landed in the histogram, in the 1234 <= 2500
    // bucket (values live in _bucket lines; _count carries the sample count).
    const family = metrics
      .split("\n")
      .find((line) =>
        line.startsWith("keeperhub_executor_dispatch_latency_ms_count")
      );
    expect(family).toBeDefined();
    expect(family).toContain("} 1");
    const bucket = metrics
      .split("\n")
      .find((line) =>
        line.startsWith('keeperhub_executor_dispatch_latency_ms_bucket{le="2500"')
      );
    expect(bucket).toBeDefined();
    expect(bucket).toContain("} 1");
  });

  it("records an execution sample for in-process runs", async () => {
    prometheusMetricsCollector.recordLatency(
      MetricNames.EXECUTOR_EXECUTION_LATENCY,
      5678,
      {
        [LabelKeys.TRIGGER_TYPE]: "schedule",
        [LabelKeys.DISPATCH_TARGET]: "in-process",
        [LabelKeys.STAGE]: "completed",
      }
    );

    const metrics = await getApiProcessMetrics();
    const family = metrics
      .split("\n")
      .find((line) =>
        line.startsWith("keeperhub_executor_execution_latency_ms_count")
      );
    expect(family).toBeDefined();
    expect(family).toContain("} 1");
  });

  it("records the observed -> broadcast distribution", async () => {
    prometheusMetricsCollector.recordLatency(
      MetricNames.EXECUTOR_BROADCAST_LATENCY,
      4321,
      {
        [LabelKeys.TRIGGER_TYPE]: "event",
        [LabelKeys.DISPATCH_TARGET]: "in-process",
      }
    );

    const metrics = await getApiProcessMetrics();
    const family = metrics
      .split("\n")
      .find((line) =>
        line.startsWith("keeperhub_executor_broadcast_latency_ms_count")
      );
    expect(family).toBeDefined();
    expect(family).toContain("} 1");
  });

  it("increments the broadcast counter", async () => {
    prometheusMetricsCollector.incrementCounter(
      MetricNames.EXECUTOR_BROADCASTS_TOTAL
    );

    const metrics = await getApiProcessMetrics();
    const family = metrics
      .split("\n")
      .find((line) =>
        line.startsWith("keeperhub_executor_broadcasts_total")
      );
    // Label-less counter: no braces, plain "name 1".
    expect(family).toBeDefined();
    expect(family).toMatch(/ 1$/);
  });

  it("never labels latency histograms with the correlation id", () => {
    // The correlation id is fresh per execution: labeling with it creates one
    // time series per run (#2289 rules out even per-workflow labels). The id
    // belongs in logs / KH_CORRELATION_ID only.
    expect(Object.values(LabelKeys)).not.toContain("correlation_id");
  });
});
