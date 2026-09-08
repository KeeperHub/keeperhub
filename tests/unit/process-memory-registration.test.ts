import { beforeAll, describe, expect, it, vi } from "vitest";

// `server-only` throws on import outside a React Server Component. Stub it so
// the guard stays in the source while the real collector loads here.
vi.mock("server-only", () => ({}));

/**
 * Registration test against the real prom-client registry.
 *
 * The sampler suite stubs the gauges out; this one covers the other half - that
 * the gauges exist under the expected names and reach the scrape output. A
 * gauge registered on dbRegistry instead of apiRegistry would never be scraped
 * from the app pods, because only /api/metrics/api is wired to a ServiceMonitor.
 */
const GAUGE_NAMES = [
  "keeperhub_process_memory_rss_bytes",
  "keeperhub_process_memory_heap_used_bytes",
  "keeperhub_process_memory_external_bytes",
  "keeperhub_process_memory_array_buffers_bytes",
  "keeperhub_process_memory_rss_peak_bytes",
  "keeperhub_process_memory_heap_used_peak_bytes",
  "keeperhub_process_memory_external_peak_bytes",
  "keeperhub_process_memory_array_buffers_peak_bytes",
  "keeperhub_container_memory_current_bytes",
  "keeperhub_container_memory_peak_bytes",
  "keeperhub_container_memory_limit_bytes",
  "keeperhub_container_memory_oom_kills",
];

const RUNTIME_NAMES = [
  "nodejs_heap_space_size_used_bytes",
  "nodejs_eventloop_lag_seconds",
  "nodejs_gc_duration_seconds",
  "process_resident_memory_bytes",
];

describe("Process memory gauge registration", () => {
  let merged: string;
  let dbOnly: string;

  beforeAll(async () => {
    const { getDbMetrics, getPrometheusMetrics } = await import(
      "@/lib/metrics/collectors/prometheus"
    );
    const { updateProcessMemoryGauges } = await import(
      "@/lib/metrics/instrumentation/process-memory"
    );

    updateProcessMemoryGauges();
    merged = await getPrometheusMetrics();
    dbOnly = await getDbMetrics();
  });

  it("exposes every bucket and its peak under the keeperhub_ prefix", () => {
    for (const name of GAUGE_NAMES) {
      expect(merged).toContain(`# TYPE ${name} gauge`);
    }
  });

  it("reports a real, non-zero resident set size", () => {
    const match = merged.match(/^keeperhub_process_memory_rss_bytes (\d+)$/m);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
  });

  it("registers the Node runtime metrics too", () => {
    for (const name of RUNTIME_NAMES) {
      expect(merged).toContain(name);
    }
  });

  // The scrape split is the load-bearing part: only /api/metrics/api is wired
  // to a ServiceMonitor on the app pods, and that route serves apiRegistry
  // alone. Anything registered on dbRegistry by mistake would render here (the
  // merged view) and still never be scraped in prod.
  it("keeps the per-pod metrics off the DB registry", () => {
    for (const name of [...GAUGE_NAMES, ...RUNTIME_NAMES]) {
      expect(dbOnly).not.toContain(name);
    }
  });

  it("survives a second import without a duplicate registration", async () => {
    vi.resetModules();

    await expect(
      import("@/lib/metrics/collectors/prometheus")
    ).resolves.toBeDefined();
  });
});
