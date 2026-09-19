import { describe, expect, it, type Mock, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

// lib/metrics/collectors/prometheus.ts is server-only; stub it so the lazy
// counter import inside broadcast-marker can resolve (same approach as
// broadcast-marker.test.ts).
vi.mock("server-only", () => ({}));

// The marker dir is resolved at module load; point it at a scratch dir
// before the first import. Mirrors broadcast-marker.test.ts's afterAll:
// restore the env and remove the scratch dir so neither leaks past this
// file's worker.
const TMP = mkdtempSync(join(tmpdir(), "kh-inprocess-cleanup-test-"));
const PREV_MARKER_DIR = process.env.KH_BROADCAST_MARKER_DIR;
process.env.KH_BROADCAST_MARKER_DIR = TMP;

afterAll(() => {
  if (PREV_MARKER_DIR === undefined) {
    delete process.env.KH_BROADCAST_MARKER_DIR;
  } else {
    process.env.KH_BROADCAST_MARKER_DIR = PREV_MARKER_DIR;
  }
  rmSync(TMP, { recursive: true, force: true });
});

// The run under test must broadcast (write its marker) and then throw, so
// the engine mock does exactly that before failing. Same relative specifier
// in-process.ts uses, so this is the same module instance the real call
// path would reach.
vi.mock("../lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: vi.fn(async () => {
    const { markBroadcast } = await import("./lib/broadcast-marker");
    markBroadcast("exec-fail");
    throw new Error("boom after broadcast");
  }),
}));

// Everything else executeInProcess touches on the way to and through the
// failure catch - DB access, validation, metrics - is stubbed at the same
// specifier in-process.ts imports them from.
vi.mock("../lib/workflow/load-for-execution", () => ({
  loadWorkflowForExecution: vi.fn(async () => ({
    status: "ok",
    workflow: { nodes: [], edges: [], organizationId: "org-1" },
    organizationName: "Org",
  })),
}));
vi.mock("../lib/db/integrations", () => ({
  validateWorkflowIntegrations: vi.fn(async () => ({ valid: true })),
}));
vi.mock("../lib/workflow/executor/build-executor-input", () => ({
  buildExecutorInput: vi.fn((_wf: unknown, input: unknown) => input),
}));
vi.mock("./lib/db-helpers", () => ({
  updateExecutionStatus: vi.fn(async () => undefined),
  updateScheduleStatus: vi.fn(async () => undefined),
  initializeExecutionProgress: vi.fn(async () => undefined),
  applyExecutionResult: vi.fn(async () => ({ errorMessage: undefined })),
}));
vi.mock("../lib/metrics", () => ({
  getMetricsCollector: vi.fn(() => ({ recordLatency: vi.fn() })),
}));
vi.mock("../lib/metrics/types", () => ({
  LabelKeys: {},
  MetricNames: {},
}));
vi.mock("./api-execute", () => ({
  executeViaApi: vi.fn(),
}));
vi.mock("../lib/logging", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const { executeInProcess } = await import("./in-process");
const broadcastMarker = await import("./lib/broadcast-marker");
const { getBroadcastMarkerPath } = broadcastMarker;
// This test stands in for the executor process, the only kind of process that
// may populate the registry: flip the write gate so markBroadcast in the
// engine mock actually writes the file the failure catch must remove.
broadcastMarker.enableBroadcastMarkers();
const dbHelpers = await import("./lib/db-helpers");

afterEach(() => {
  rmSync(join(TMP, "exec-fail.json"), { force: true });
  rmSync(join(TMP, "exec-nomark.json"), { force: true });
  vi.clearAllMocks();
});

describe("executeInProcess broadcast marker cleanup (issue #2289 blocking item)", () => {
  it("a run that broadcasts and then throws leaves no marker file behind", async () => {
    // The engine mock writes exec-fail.json via the real markBroadcast, then
    // throws. The success path's takeBroadcastMarker never runs; the catch
    // is the only thing that can remove the file.
    await executeInProcess({
      workflowId: "wf-1",
      executionId: "exec-fail",
      input: {},
      triggerType: "manual",
      db: {} as never,
    });

    expect(existsSync(getBroadcastMarkerPath("exec-fail"))).toBe(false);
    // The failure still lands as an execution error, after the cleanup.
    expect(dbHelpers.updateExecutionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "exec-fail",
      "error",
      expect.objectContaining({ error: "boom after broadcast" })
    );
  });

  it("threads the executor's epochs into the in-process timeline", async () => {
    // The executor stamps observed/received on its own instance before the
    // hand-off. Passing only the correlation id left stageMs("received",
    // "started") and stageMs("observed", "broadcast") permanently undefined
    // here, so the in-process queue leg was measured nowhere (index.ts skips
    // the dispatch histogram for this target) and the headline observed ->
    // broadcast histogram had no in-process series at all.
    const { executeWorkflow } = await import(
      "../lib/workflow/executor/executor.workflow"
    );
    vi.mocked(executeWorkflow).mockImplementationOnce(async () => {
      const { markBroadcast } = await import("./lib/broadcast-marker");
      markBroadcast("exec-timeline");
      return { success: true, results: {}, outputs: {} };
    });

    await executeInProcess({
      workflowId: "wf-1",
      executionId: "exec-timeline",
      input: {},
      triggerType: "event",
      db: {} as never,
      correlationId: "corr-timeline",
      latencyEpochs: { receivedAt: 1_000, observedAt: 900 },
    });

    const { logInfo } = await import("../lib/logging");
    const line = vi
      .mocked(logInfo)
      .mock.calls.find(([message]) => message === "execution latency stages");
    expect(line).toBeDefined();
    const labels = line?.[1] as Record<string, string>;
    expect(labels.correlation_id).toBe("corr-timeline");
    // Both executor epochs survive into the emitted timeline: the sample line
    // documented in the PR description is now producible on this path.
    expect(labels.observedAt).toBe(new Date(900).toISOString());
    expect(labels.receivedAt).toBe(new Date(1_000).toISOString());
    // The queue leg and the headline interval both exist now.
    expect(Number(labels.queueToStartMs)).toBeGreaterThanOrEqual(0);
    expect(Number(labels.observed_to_broadcast_ms)).toBeGreaterThanOrEqual(0);
    // receive -> terminal, anchored to the executor's receive stamp (epoch
    // 1_000) rather than to this process's own start a few ms ago.
    expect(Number(labels.totalMs)).toBeGreaterThan(1_000_000);

    // All three in-process series are recorded: dispatch (received ->
    // started), execution (received -> terminal) and the headline broadcast.
    const { getMetricsCollector } = await import("../lib/metrics");
    const recorded = vi
      .mocked(getMetricsCollector)
      .mock.results.flatMap((result) =>
        (result.value as { recordLatency: Mock }).recordLatency.mock.calls.map(
          (call) => call[1] as number
        )
      );
    expect(recorded).toHaveLength(3);
    expect(recorded.some((ms) => ms > 1_000_000)).toBe(true);
  });

  it("a failing run with no broadcast marker cleans up nothing and still reports the error", async () => {
    vi.mocked(
      (await import("../lib/workflow/executor/executor.workflow"))
        .executeWorkflow
    ).mockImplementationOnce(async () => {
      throw new Error("boom before broadcast");
    });

    await expect(
      executeInProcess({
        workflowId: "wf-1",
        executionId: "exec-nomark",
        input: {},
        triggerType: "manual",
        db: {} as never,
      })
    ).resolves.toBeUndefined();

    expect(existsSync(getBroadcastMarkerPath("exec-nomark"))).toBe(false);
    expect(dbHelpers.updateExecutionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "exec-nomark",
      "error",
      expect.objectContaining({ error: "boom before broadcast" })
    );
  });
});
