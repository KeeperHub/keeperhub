import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh module registry per test so the module-level marker path resolution
// and env reads behave; the sidecar points at a scratch dir.
const tmp = mkdtempSync(join(tmpdir(), "kh-obs-test-"));
process.env.KH_BROADCAST_MARKER = join(tmp, "marker.json");

afterEach(() => {
  delete process.env.KH_CORRELATION_ID;
  delete process.env.KH_RECEIVED_AT;
  delete process.env.KH_OBSERVED_AT;
  rmSync(join(tmp, "marker.json"), { force: true });
});

const BASE = {
  executionId: "exec-1",
  workflowId: "wf-1",
  triggerType: "event",
};

async function fresh() {
  return await import("./latency-observations");
}

describe("collectLatencyObservations", () => {
  it("returns nothing without a correlation id (legacy run)", async () => {
    const { collectLatencyObservations } = await fresh();
    const obs = collectLatencyObservations({
      ...BASE,
      receivedAt: 1000,
      observedAt: 900,
      completedAt: 2000,
    });
    expect(obs).toEqual([]);
  });

  it("collects observed-broadcast from the sidecar marker plus KH_OBSERVED_AT", async () => {
    process.env.KH_CORRELATION_ID = "corr-1";
    process.env.KH_OBSERVED_AT = "1000";
    writeFileSync(
      join(tmp, "marker.json"),
      JSON.stringify({ executionId: "exec-1", broadcastAt: 4500 }),
      "utf-8"
    );
    const { collectLatencyObservations } = await fresh();
    const obs = collectLatencyObservations({
      ...BASE,
      receivedAt: 1200,
      observedAt: 1000,
      completedAt: 9000,
    });
    // Both intervals are anchored here: observed-broadcast from the marker,
    // received-completed from KH_RECEIVED_AT.
    expect(obs).toHaveLength(2);
    expect(obs[0]).toEqual({
      correlationId: "corr-1",
      executionId: "exec-1",
      workflowId: "wf-1",
      triggerType: "event",
      dispatchTarget: "k8s-job",
      stage: "observed-broadcast",
      durationMs: 3500,
    });
    expect(obs[1]).toMatchObject({ stage: "received-completed", durationMs: 7800 });
  });

  it("collects received-completed from KH_RECEIVED_AT", async () => {
    process.env.KH_CORRELATION_ID = "corr-2";
    process.env.KH_RECEIVED_AT = "1500";
    const { collectLatencyObservations } = await fresh();
    const obs = collectLatencyObservations({
      ...BASE,
      receivedAt: 1500,
      observedAt: undefined, // legacy message: no tracker observation
      completedAt: 5200,
    });
    expect(obs).toEqual([
      expect.objectContaining({
        correlationId: "corr-2",
        stage: "received-completed",
        durationMs: 3700,
      }),
    ]);
  });

  it("emits no negative observed-broadcast when observedAt postdates the marker", async () => {
    process.env.KH_CORRELATION_ID = "corr-3";
    process.env.KH_OBSERVED_AT = "99999";
    writeFileSync(
      join(tmp, "marker.json"),
      JSON.stringify({ executionId: "exec-1", broadcastAt: 4500 }),
      "utf-8"
    );
    const { collectLatencyObservations } = await fresh();
    const obs = collectLatencyObservations({
      ...BASE,
      receivedAt: 1000,
      observedAt: 99999,
      completedAt: 100000,
    });
    // Clock-skew guard: a negative interval is never shipped.
    expect(obs.find((o) => o.stage === "observed-broadcast")).toBeUndefined();
  });

  it("tolerates a missing/cleared marker: other observations still ship", async () => {
    process.env.KH_CORRELATION_ID = "corr-4";
    process.env.KH_RECEIVED_AT = "100";
    const { collectLatencyObservations } = await fresh();
    const obs = collectLatencyObservations({
      ...BASE,
      receivedAt: 100,
      observedAt: 50,
      completedAt: 700,
    });
    expect(obs).toHaveLength(1);
    expect(obs[0].stage).toBe("received-completed");
  });

  it("ignores a marker owned by a different execution", async () => {
    process.env.KH_CORRELATION_ID = "corr-5";
    process.env.KH_OBSERVED_AT = "1000";
    writeFileSync(
      join(tmp, "marker.json"),
      JSON.stringify({ executionId: "exec-OTHER", broadcastAt: 4500 }),
      "utf-8"
    );
    const { collectLatencyObservations } = await fresh();
    const obs = collectLatencyObservations({
      ...BASE,
      receivedAt: 1000,
      observedAt: 1000,
      completedAt: 8000,
    });
    expect(obs.find((o) => o.stage === "observed-broadcast")).toBeUndefined();
  });
});
