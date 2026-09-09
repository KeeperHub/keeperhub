import { afterEach, afterAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The marker path is resolved at module load; point it at a scratch file
// before the first import. lib/workflow/executor/error-context is imported
// for its ALS reader; it is storage-optional by design, so no
// AsyncLocalStorage needs registering in this process.
const MARKER_PATH = join(tmpdir(), `kh-broadcast-marker-test-${process.pid}.json`);
process.env.KH_BROADCAST_MARKER = MARKER_PATH;

const {
  markBroadcast,
  takeBroadcastMarker,
  getBroadcastCount,
  currentExecutionId,
} = await import("./broadcast-marker");

afterEach(() => {
  rmSync(MARKER_PATH, { force: true });
});

afterAll(() => {
  delete process.env.KH_BROADCAST_MARKER;
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

  it("writes and reads back the sidecar for the owning execution", () => {
    const before = getBroadcastCount();
    markBroadcast("exec-42");

    const marker = takeBroadcastMarker();
    expect(marker).toEqual({
      executionId: "exec-42",
      broadcastAt: expect.any(Number),
    });
    // Read-and-clear: a second read finds nothing.
    expect(takeBroadcastMarker()).toBeUndefined();
    expect(getBroadcastCount()).toBe(before + 1);
  });

  it("returns undefined when no broadcast was marked this run", () => {
    expect(takeBroadcastMarker()).toBeUndefined();
  });

  it("treats a corrupt sidecar as no marker", () => {
    writeFileSync(MARKER_PATH, "{not json", "utf-8");
    expect(takeBroadcastMarker()).toBeUndefined();
    // The corrupt file was consumed (cleared) rather than left to haunt.
    expect(existsSync(MARKER_PATH)).toBe(false);
  });

  it("rejects a sidecar with the wrong shape", () => {
    writeFileSync(
      MARKER_PATH,
      JSON.stringify({ executionId: 42, broadcastAt: "nope" }),
      "utf-8"
    );
    expect(takeBroadcastMarker()).toBeUndefined();
  });

  it("does not write the sidecar outside a run, but still counts", () => {
    markBroadcast(undefined);
    expect(existsSync(MARKER_PATH)).toBe(false);
  });
});
