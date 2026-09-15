import { beforeEach, describe, expect, it } from "vitest";

const { trackLatency, peekLatency, takeLatency, clearLatencyMap } = await import(
  "./correlation-map"
);
const { ExecutionLatency } = await import("../latency");

beforeEach(() => {
  clearLatencyMap();
});

describe("correlation map", () => {
  it("tracks and peeks without removing", () => {
    const latency = new ExecutionLatency("corr-a");
    trackLatency(latency);
    expect(peekLatency("corr-a")).toBe(latency);
    expect(peekLatency("corr-a")).toBe(latency); // still there
  });

  it("take removes the entry", () => {
    const latency = new ExecutionLatency("corr-b");
    trackLatency(latency);
    expect(takeLatency("corr-b")).toBe(latency);
    expect(peekLatency("corr-b")).toBeUndefined();
    expect(takeLatency("corr-b")).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(peekLatency("nope")).toBeUndefined();
    expect(takeLatency("nope")).toBeUndefined();
  });

  it("evicts the oldest entry at the cap instead of growing unbounded", async () => {
    // Re-import with a tiny cap via module state: the cap is a module
    // constant, so exercise the real one cheaply by tracking cap+1 entries.
    const capModule = await import("./correlation-map");
    const { MAX_TRACKED } = (capModule as unknown as {
      MAX_TRACKED?: number;
    }) as { MAX_TRACKED?: number };
    const limit = MAX_TRACKED ?? 1024;
    const first = new ExecutionLatency("corr-first");
    trackLatency(first);
    for (let i = 0; i < limit; i++) {
      trackLatency(new ExecutionLatency(`corr-${i}`));
    }
    // The oldest was evicted; the newest survive.
    expect(peekLatency("corr-first")).toBeUndefined();
    expect(peekLatency(`corr-${limit - 1}`)).toBeDefined();
  });
});
