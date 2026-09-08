import { describe, expect, it } from "vitest";
import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  type ConditionDecision,
  collectAllSkippedTargets,
  collectSkippedTargets,
} from "@/lib/workflow/nodes/condition/skipped-branch";

type EdgeLike = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

function createEdge(
  source: string,
  target: string,
  sourceHandle?: string
): EdgeLike {
  return { source, target, sourceHandle };
}

describe("collectSkippedTargets", () => {
  it("returns false-handle targets when true handle was taken", () => {
    const edges: EdgeLike[] = [
      createEdge("cond-1", "action-a", "true"),
      createEdge("cond-1", "action-b", "true"),
      createEdge("cond-1", "action-c", "false"),
      createEdge("cond-1", "action-d", "false"),
    ];
    const edgeMap = buildEdgesBySourceHandle(edges);

    const skipped = collectSkippedTargets("cond-1", "false", edgeMap);
    expect(skipped).toEqual(["action-c", "action-d"]);
  });

  it("returns true-handle targets when false handle was taken", () => {
    const edges: EdgeLike[] = [
      createEdge("cond-1", "action-a", "true"),
      createEdge("cond-1", "action-b", "false"),
    ];
    const edgeMap = buildEdgesBySourceHandle(edges);

    const skipped = collectSkippedTargets("cond-1", "true", edgeMap);
    expect(skipped).toEqual(["action-a"]);
  });

  it("returns empty array when not-taken handle has no edges", () => {
    const edges: EdgeLike[] = [createEdge("cond-1", "action-a", "true")];
    const edgeMap = buildEdgesBySourceHandle(edges);

    const skipped = collectSkippedTargets("cond-1", "false", edgeMap);
    expect(skipped).toEqual([]);
  });

  it("returns empty array when condition node has no handle edges", () => {
    const edgeMap = buildEdgesBySourceHandle([]);

    const skipped = collectSkippedTargets("cond-1", "false", edgeMap);
    expect(skipped).toEqual([]);
  });

  it("returns all targets when false handle has multiple edges", () => {
    const edges: EdgeLike[] = [
      createEdge("cond-1", "a", "true"),
      createEdge("cond-1", "b", "false"),
      createEdge("cond-1", "c", "false"),
      createEdge("cond-1", "d", "false"),
    ];
    const edgeMap = buildEdgesBySourceHandle(edges);

    const skipped = collectSkippedTargets("cond-1", "false", edgeMap);
    expect(skipped).toEqual(["b", "c", "d"]);
  });
});

describe("collectAllSkippedTargets", () => {
  it("aggregates skipped targets from multiple condition decisions", () => {
    const decisions = new Map<string, ConditionDecision>([
      ["cond-1", { taken: "true", skippedTargets: ["skip-a", "skip-b"] }],
      ["cond-2", { taken: "false", skippedTargets: ["skip-c"] }],
    ]);

    const allSkipped = collectAllSkippedTargets(decisions);
    expect(allSkipped).toEqual(new Set(["skip-a", "skip-b", "skip-c"]));
  });

  it("returns empty set when no decisions exist", () => {
    const decisions = new Map<string, ConditionDecision>();
    const allSkipped = collectAllSkippedTargets(decisions);
    expect(allSkipped.size).toBe(0);
  });

  it("deduplicates targets that appear in multiple decisions", () => {
    const decisions = new Map<string, ConditionDecision>([
      ["cond-1", { taken: "true", skippedTargets: ["shared", "only-1"] }],
      ["cond-2", { taken: "true", skippedTargets: ["shared", "only-2"] }],
    ]);

    const allSkipped = collectAllSkippedTargets(decisions);
    expect(allSkipped).toEqual(new Set(["shared", "only-1", "only-2"]));
    expect(allSkipped.size).toBe(3);
  });

  it("handles decisions with empty skippedTargets", () => {
    const decisions = new Map<string, ConditionDecision>([
      ["cond-1", { taken: "true", skippedTargets: [] }],
      ["cond-2", { taken: "false", skippedTargets: ["skip-a"] }],
    ]);

    const allSkipped = collectAllSkippedTargets(decisions);
    expect(allSkipped).toEqual(new Set(["skip-a"]));
  });

  it("excludes a node that another condition actually took (shared alert node)", () => {
    // cond-1 passes: its false branch (alert) is not taken.
    // cond-2 fails: its false branch takes the same alert node, which executes.
    const decisions = new Map<string, ConditionDecision>([
      [
        "cond-1",
        { taken: "true", skippedTargets: ["alert"], takenTargets: [] },
      ],
      [
        "cond-2",
        { taken: "false", skippedTargets: [], takenTargets: ["alert"] },
      ],
    ]);

    const allSkipped = collectAllSkippedTargets(decisions);
    expect(allSkipped.has("alert")).toBe(false);
  });
});
