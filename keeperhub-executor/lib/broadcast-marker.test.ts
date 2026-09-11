import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/metrics/collectors/prometheus.ts is server-only; stub it so the lazy
// counter import inside broadcast-marker can resolve (same approach as
// lib/metrics/__tests__/executor-latency.test.ts).
vi.mock("server-only", () => ({}));

// The marker dir is resolved at module load; point it at a scratch dir before
// the first import. The error-context reader is storage-optional by design;
// tests that need an execution id resolved from ALS register their own
// AsyncLocalStorage (see the bootstrap test).
const TMP = mkdtempSync(join(tmpdir(), "kh-broadcast-marker-test-"));
process.env.KH_BROADCAST_MARKER_DIR = TMP;

const {
  markBroadcast,
  peekBroadcastMarker,
  takeBroadcastMarker,
  getBroadcastCount,
  getBroadcastMarkerPath,
  currentExecutionId,
} = await import("./broadcast-marker");

afterEach(() => {
  rmSync(join(TMP, "exec-1.json"), { force: true });
  rmSync(join(TMP, "exec-2.json"), { force: true });
});

afterAll(() => {
  delete process.env.KH_BROADCAST_MARKER_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("broadcast marker (issue #2289 broadcast stage)", () => {
  it("resolves the execution id from the async-local workflow context", () => {
    // No ALS registered in this test process -> undefined, never a throw.
    expect(currentExecutionId()).toBeUndefined();
  });

  it("bumps the process-local counter on every broadcast", () => {
    const before = getBroadcastCount();
    markBroadcast("exec-1");
    markBroadcast(undefined); // outside a run: counter only
    expect(getBroadcastCount()).toBe(before + 2);
  });

  it("writes a per-execution marker file that peek reads back", () => {
    const before = Date.now();
    markBroadcast("exec-1");
    const marker = peekBroadcastMarker("exec-1");
    expect(marker).toBeDefined();
    expect(marker!.executionId).toBe("exec-1");
    expect(marker!.broadcastAt).toBeGreaterThanOrEqual(before);
    expect(existsSync(getBroadcastMarkerPath("exec-1"))).toBe(true);
  });

  it("peek is non-destructive: take still reads the same record afterwards", () => {
    markBroadcast("exec-1");
    const peeked = peekBroadcastMarker("exec-1");
    const taken = takeBroadcastMarker("exec-1");
    expect(peeked).toEqual(taken);
    // Consumed now.
    expect(takeBroadcastMarker("exec-1")).toBeUndefined();
  });

  it("take removes only the requested execution's marker", () => {
    markBroadcast("exec-1");
    writeFileSync(
      getBroadcastMarkerPath("exec-2"),
      JSON.stringify({ executionId: "exec-2", broadcastAt: Date.now() }),
      "utf-8"
    );
    expect(takeBroadcastMarker("exec-1")!.executionId).toBe("exec-1");
    // Run B's marker is untouched: concurrent in-process executions cannot
    // steal each other's sample (the fixed-filename defect class).
    expect(peekBroadcastMarker("exec-2")!.executionId).toBe("exec-2");
  });

  it("tolerates a corrupt marker file", () => {
    writeFileSync(getBroadcastMarkerPath("exec-1"), "not json", "utf-8");
    expect(peekBroadcastMarker("exec-1")).toBeUndefined();
    expect(takeBroadcastMarker("exec-1")).toBeUndefined();
    // The corrupt file is consumed by take rather than left behind.
    expect(existsSync(getBroadcastMarkerPath("exec-1"))).toBe(false);
  });

  it("increments the registered keeperhub_executor_broadcasts_total counter", async () => {
    const { executorBroadcastsTotal } = await import(
      "@/lib/metrics/collectors/prometheus"
    );
    const before = (await executorBroadcastsTotal.get()).values[0]?.value ?? 0;
    // Resolution is asynchronous (lazy import); allow the module's import
    // promise to settle before asserting the flush.
    await new Promise((resolve) => setImmediate(resolve));
    markBroadcast("exec-1");
    markBroadcast(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const after = (await executorBroadcastsTotal.get()).values[0]?.value ?? 0;
    expect(after).toBeGreaterThanOrEqual(before + 2);
  });
});
