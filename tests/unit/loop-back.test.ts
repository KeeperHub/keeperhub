import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createLoopBackTracker,
  findUnsupportedBackEdges,
  MAX_LOOP_ITERATIONS,
  MAX_LOOP_TRAVERSALS_PER_EXECUTION,
  resetLoopBodyState,
} from "@/lib/workflow/executor/loop-back";

describe("createLoopBackTracker", () => {
  it("numbers the passes of one loop from 1", () => {
    const tracker = createLoopBackTracker();
    expect(tracker.admit("D", "B", ["B", "C", "D"])).toEqual({
      admitted: true,
      iteration: 1,
    });
    expect(tracker.admit("D", "B", ["B", "C", "D"])).toEqual({
      admitted: true,
      iteration: 2,
    });
  });

  it("counts each loop separately", () => {
    const tracker = createLoopBackTracker();
    tracker.admit("D", "B", ["B", "D"]);
    tracker.admit("D", "B", ["B", "D"]);
    expect(tracker.admit("F", "E", ["E", "F"])).toEqual({
      admitted: true,
      iteration: 1,
    });
  });

  it("refuses the pass past the per-loop cap and names the loop entry", () => {
    const tracker = createLoopBackTracker({
      maxIterationsPerLoop: 2,
      labelOf: (id) => (id === "B" ? "Check Balance" : id),
    });
    tracker.admit("D", "B", ["B", "D"]);
    tracker.admit("D", "B", ["B", "D"]);

    const refused = tracker.admit("D", "B", ["B", "D"]);
    expect(refused.admitted).toBe(false);
    if (refused.admitted) {
      throw new Error("expected the third pass to be refused");
    }
    expect(refused.error).toContain("Check Balance");
    expect(refused.error).toContain("2 iterations");
  });

  it("refuses on the per-execution cap even when no single loop is over", () => {
    const tracker = createLoopBackTracker({
      maxIterationsPerLoop: 10,
      maxTraversalsPerExecution: 3,
    });
    tracker.admit("D", "B", ["B", "D"]);
    tracker.admit("D", "B", ["B", "D"]);
    tracker.admit("F", "E", ["E", "F"]);

    const refused = tracker.admit("F", "E", ["E", "F"]);
    expect(refused.admitted).toBe(false);
    if (refused.admitted) {
      throw new Error("expected the fourth traversal to be refused");
    }
    expect(refused.error).toContain("3 loop iterations");
  });

  it("does not spend the execution budget on a refused pass", () => {
    const tracker = createLoopBackTracker({ maxIterationsPerLoop: 1 });
    tracker.admit("D", "B", ["B", "D"]);
    tracker.admit("D", "B", ["B", "D"]);
    expect(tracker.totalTraversals()).toBe(1);
  });

  it("reports the pass each body node is on", () => {
    const tracker = createLoopBackTracker();
    expect(tracker.iterationOf("C")).toBe(0);
    tracker.admit("D", "B", ["B", "C", "D"]);
    expect(tracker.iterationOf("C")).toBe(1);
    expect(tracker.iterationOf("Z")).toBe(0);
  });

  it("ships caps that bound a runaway loop", () => {
    expect(MAX_LOOP_ITERATIONS).toBeGreaterThan(0);
    expect(MAX_LOOP_TRAVERSALS_PER_EXECUTION).toBeGreaterThanOrEqual(
      MAX_LOOP_ITERATIONS
    );
  });
});

describe("resetLoopBodyState", () => {
  it("re-arms only the loop body, leaving the rest of the run alone", () => {
    const state = {
      visited: new Set(["T", "A", "B", "C", "D"]),
      convergenceArrivals: new Map([
        ["C", new Set(["B"])],
        ["J", new Set(["X"])],
      ]),
      convergenceSkipArrivals: new Map([["C", new Set(["B"])]]),
      skippedNodes: new Set(["C", "Z"]),
    };

    resetLoopBodyState(["B", "C", "D"], state);

    expect([...state.visited].sort()).toEqual(["A", "T"]);
    expect(state.convergenceArrivals.has("C")).toBe(false);
    expect(state.convergenceArrivals.has("J")).toBe(true);
    expect(state.convergenceSkipArrivals.has("C")).toBe(false);
    expect([...state.skippedNodes]).toEqual(["Z"]);
  });
});

describe("findUnsupportedBackEdges", () => {
  const forEachBody = new Set(["B1", "B2"]);

  it("passes a back edge clear of every For Each body", () => {
    expect(
      findUnsupportedBackEdges([{ source: "D", target: "B" }], forEachBody)
    ).toEqual([]);
  });

  it("flags a back edge leaving a For Each body", () => {
    expect(
      findUnsupportedBackEdges([{ source: "B2", target: "A" }], forEachBody)
    ).toHaveLength(1);
  });

  it("flags a back edge entering a For Each body", () => {
    expect(
      findUnsupportedBackEdges([{ source: "D", target: "B1" }], forEachBody)
    ).toHaveLength(1);
  });
});
