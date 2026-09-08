/**
 * A fan-in join is released by an arrival counter: each parallel branch adds
 * its own id, and the branch that brings the count up to the join's in-degree
 * is the one that runs it. If a single branch never signals, the join is never
 * scheduled -- and because computeFinalSuccess only inspects nodes present in
 * `results`, a node that was never scheduled cannot fail the run.
 *
 * That is what let a 14-wide monitor finish with its aggregate and Discord
 * alert unrun and still report success. These tests pin the detection that
 * turns the orphan into a real failure.
 */

import { describe, expect, it } from "vitest";
import {
  computeFinalSuccess,
  type ExecutionResult,
  findOrphanedNodes,
} from "@/lib/workflow/executor/final-success";

type Edge = { source: string; target: string };

function edgesByTarget(edges: Edge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = map.get(edge.target) ?? [];
    if (!sources.includes(edge.source)) {
      sources.push(edge.source);
    }
    map.set(edge.target, sources);
  }
  return map;
}

function succeeded(nodeIds: string[]): Record<string, ExecutionResult> {
  return Object.fromEntries(nodeIds.map((id) => [id, { success: true }]));
}

/** trigger -> N parallel reads -> join -> condition -> alert */
function fanInGraph(width: number): { edges: Edge[]; reads: string[] } {
  const reads = Array.from({ length: width }, (_, i) => `read-${i}`);
  const edges: Edge[] = [
    ...reads.map((id) => ({ source: "trigger", target: id })),
    ...reads.map((id) => ({ source: id, target: "join" })),
    { source: "join", target: "condition" },
    { source: "condition", target: "alert" },
  ];
  return { edges, reads };
}

describe("findOrphanedNodes", () => {
  it("flags a join that never ran although every upstream branch completed", () => {
    const { edges, reads } = fanInGraph(14);
    const attempted = new Set(["trigger", ...reads]);

    const orphaned = findOrphanedNodes({
      attempted,
      results: succeeded(["trigger", ...reads]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual(["join"]);
  });

  it("turns a silently-green run into a failure", () => {
    const { edges, reads } = fanInGraph(14);
    const results = succeeded(["trigger", ...reads]);

    expect(computeFinalSuccess(results, new Set())).toBe(true);

    for (const orphanId of findOrphanedNodes({
      attempted: new Set(["trigger", ...reads]),
      results,
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    })) {
      results[orphanId] = { success: false, error: "never executed" };
    }

    expect(computeFinalSuccess(results, new Set())).toBe(false);
  });

  it("reports only the join, not the nodes stranded behind it", () => {
    const { edges, reads } = fanInGraph(10);

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", ...reads]),
      results: succeeded(["trigger", ...reads]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).not.toContain("condition");
    expect(orphaned).not.toContain("alert");
  });

  it("stays quiet when the join ran", () => {
    const { edges, reads } = fanInGraph(14);
    const all = ["trigger", ...reads, "join", "condition", "alert"];

    const orphaned = findOrphanedNodes({
      attempted: new Set(all),
      results: succeeded(all),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual([]);
  });

  it("does not flag a join whose upstream failed", () => {
    const { edges, reads } = fanInGraph(5);
    const results = succeeded(["trigger", ...reads]);
    results["read-2"] = { success: false, error: "rpc down" };

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", ...reads]),
      results,
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual([]);
  });

  it("does not flag a node on a not-taken condition branch", () => {
    const edges: Edge[] = [
      { source: "trigger", target: "condition" },
      { source: "condition", target: "alert" },
    ];

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", "condition"]),
      results: succeeded(["trigger", "condition"]),
      skipped: new Set(["alert"]),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual([]);
  });

  it("does not flag a condition's target when no skip was recorded", () => {
    const edges: Edge[] = [
      { source: "trigger", target: "condition" },
      { source: "condition", target: "alert" },
    ];

    // Legacy edges carry no sourceHandle, so the not-taken branch leaves no
    // skip record and an unrun target is indistinguishable from an orphan.
    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", "condition"]),
      results: succeeded(["trigger", "condition"]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual([]);
  });

  it("does not flag a disabled node, which is attempted but records no result", () => {
    const edges: Edge[] = [
      { source: "trigger", target: "disabled" },
      { source: "disabled", target: "tail" },
    ];

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", "disabled", "tail"]),
      results: succeeded(["trigger", "tail"]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(),
    });

    expect(orphaned).toEqual([]);
  });

  it("flags a single-predecessor node stranded after its join succeeded", () => {
    // Observed in prod on a six-branch monitor: the join itself completed, and
    // the condition hanging off it on one edge never ran. Stranding is not
    // confined to the join -- any lost continuation leaves the run short.
    const reads = ["r0", "r1", "r2", "r3", "r4", "r5"];
    const edges: Edge[] = [
      ...reads.map((id) => ({ source: "trigger", target: id })),
      ...reads.map((id) => ({ source: id, target: "join" })),
      { source: "join", target: "condition" },
      { source: "condition", target: "alert" },
    ];

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", ...reads, "join"]),
      results: succeeded(["trigger", ...reads, "join"]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual(["condition"]);
  });

  it("does not flag an alert the condition legitimately routed away from", () => {
    // The same workflow on a clean run: the join and condition both ran, the
    // condition evaluated false, and the alert was correctly never reached.
    const edges: Edge[] = [
      { source: "a", target: "join" },
      { source: "b", target: "join" },
      { source: "join", target: "condition" },
      { source: "condition", target: "alert" },
    ];

    const orphaned = findOrphanedNodes({
      attempted: new Set(["a", "b", "join", "condition"]),
      results: succeeded(["a", "b", "join", "condition"]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(["condition"]),
    });

    expect(orphaned).toEqual([]);
  });

  it("does not flag For Each body nodes, which run outside the main traversal", () => {
    const edges: Edge[] = [
      { source: "trigger", target: "foreach" },
      { source: "foreach", target: "body-1" },
      { source: "body-1", target: "body-2" },
      { source: "body-2", target: "collect" },
    ];

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", "foreach"]),
      results: succeeded(["trigger", "foreach"]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(),
      excludedNodeIds: new Set(["body-1", "body-2", "collect"]),
    });

    expect(orphaned).toEqual([]);
  });

  it("flags a node stranded downstream of a disabled node", () => {
    const edges: Edge[] = [
      { source: "trigger", target: "disabled" },
      { source: "disabled", target: "tail" },
    ];

    const orphaned = findOrphanedNodes({
      attempted: new Set(["trigger", "disabled"]),
      results: succeeded(["trigger"]),
      skipped: new Set(),
      edgesByTarget: edgesByTarget(edges),
      conditionNodeIds: new Set(),
    });

    expect(orphaned).toEqual(["tail"]);
  });
});
