import { beforeEach, describe, expect, it, vi } from "vitest";

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
    // The cap is a module constant; exercise the real one by tracking
    // cap+1 entries.
    const { MAX_TRACKED } = await import("./correlation-map");
    const first = new ExecutionLatency("corr-first");
    trackLatency(first);
    for (let i = 0; i < MAX_TRACKED; i++) {
      trackLatency(new ExecutionLatency(`corr-${i}`));
    }
    // The oldest was evicted; the newest survive.
    expect(peekLatency("corr-first")).toBeUndefined();
    expect(peekLatency(`corr-${MAX_TRACKED - 1}`)).toBeDefined();
  });

  it("drops an entry older than the exported age bound on the next track", async () => {
    // The hour bound, exercised through the exported constant. The age scan
    // is throttled to once per minute on the track path, so the test crosses
    // the throttle with the system clock: the first track inserts the stale
    // entry (the scan fires on an empty map and must not remove it early),
    // time advances past the throttle, and the next track's scan - finding
    // an entry whose received stamp predates MAX_TRACKED_AGE_MS - drops it.
    vi.useFakeTimers();
    try {
      const { MAX_TRACKED_AGE_MS } = await import("./correlation-map");
      const stale = new ExecutionLatency("corr-stale");
      stale.mark("received", Date.now() - MAX_TRACKED_AGE_MS - 60_000);
      trackLatency(stale);
      expect(peekLatency("corr-stale")).toBe(stale); // inserted, not yet scanned

      vi.setSystemTime(Date.now() + 61_000); // past the scan throttle
      const fresh = new ExecutionLatency("corr-fresh");
      trackLatency(fresh);
      expect(peekLatency("corr-stale")).toBeUndefined();
      expect(peekLatency("corr-fresh")).toBe(fresh);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an entry younger than the age bound across a scan", async () => {
    // Guard on the other edge: the first track inserts the young entry (the
    // scan fires on an empty map and must not remove it early), time advances
    // past the throttle, and the next track's scan - finding only an entry
    // well inside MAX_TRACKED_AGE_MS - must leave it in place. Without
    // crossing the throttle the second track never scans and this test
    // cannot fail: the review flagged exactly that vacuous pass.
    vi.useFakeTimers();
    try {
      const young = new ExecutionLatency("corr-young");
      young.mark("received", Date.now() - 1_000);
      trackLatency(young);
      expect(peekLatency("corr-young")).toBe(young); // inserted, not yet scanned

      vi.setSystemTime(Date.now() + 61_000); // past the scan throttle
      trackLatency(new ExecutionLatency("corr-trigger-scan"));
      expect(peekLatency("corr-young")).toBe(young);
    } finally {
      vi.useRealTimers();
    }
  });

  it("at the cap, scans for stale entries before dropping the oldest inserted", async () => {
    // The cap drop is arrival-order, so a full map between throttled scans
    // would evict the oldest *inserted* entry - which can be a k8s-job run
    // still awaiting its observation - while a stale never-dispatched entry
    // keeps its slot. At MAX_TRACKED the age scan runs regardless of the
    // throttle, so the stale entry is reclaimed first and the young k8s
    // entry survives the insert.
    vi.useFakeTimers();
    try {
      const { MAX_TRACKED, MAX_TRACKED_AGE_MS } = await import(
        "./correlation-map"
      );
      // Fill the map to exactly the cap with young entries.
      for (let i = 0; i < MAX_TRACKED; i++) {
        trackLatency(new ExecutionLatency(`corr-fill-${i}`));
      }
      // Age one entry far past the bound and swap it in for a young filler,
      // so the map sits exactly at the cap with a stale entry inside.
      const stale = new ExecutionLatency("corr-cap-stale");
      stale.mark("received", Date.now() - MAX_TRACKED_AGE_MS - 60_000);
      takeLatency(`corr-fill-${MAX_TRACKED - 1}`);
      trackLatency(stale);

      // Stay inside the scan throttle (the first fill track scanned), so only
      // the cap can force this scan: the stale entry must go first, and the
      // young fill entry must survive.
      trackLatency(new ExecutionLatency("corr-cap-new"));
      expect(peekLatency("corr-cap-stale")).toBeUndefined();
      expect(peekLatency("corr-cap-new")).toBeDefined();
      // A young entry that predates this insert was not sacrificed.
      expect(peekLatency("corr-fill-0")).toBeDefined();
    } finally {
      vi.useRealTimers();
      clearLatencyMap();
    }
  });
});
