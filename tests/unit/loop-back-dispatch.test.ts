/**
 * Drives the executor's dispatch shape (forward barrier, back-edge routing,
 * body reset) over the real primitives, so the loop is exercised end to end
 * without standing up the step registry the full executor pulls in.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectReachable,
  isBackEdge,
  partitionByBackEdges,
} from "@/lib/workflow/editor/back-edges";
import {
  buildEdgesBySource,
  buildEdgesByTarget,
  getReadyDownstreamIds,
} from "@/lib/workflow/executor/convergence-barrier";
import {
  createLoopBackTracker,
  resetLoopBodyState,
} from "@/lib/workflow/executor/loop-back";

type Edge = { source: string; target: string };

type RunOutcome = {
  /** Node IDs in execution order, one entry per pass. */
  ran: string[];
  /** Cap refusals, as [node that asked to loop, message]. */
  refusals: [string, string][];
};

type RunOptions = {
  /** Returns the targets a node routes to, given how many times it has run. */
  route?: (nodeId: string, runCount: number) => string[] | undefined;
  maxIterationsPerLoop?: number;
  maxTraversalsPerExecution?: number;
};

function runGraph(
  nodeIds: string[],
  edges: Edge[],
  startId: string,
  options: RunOptions = {}
): RunOutcome {
  const nodes = nodeIds.map((id) => ({ id }));
  const { forwardEdges, backEdgesBySource } = partitionByBackEdges(
    nodes,
    edges
  );
  const edgesBySource = buildEdgesBySource(edges);
  const forwardEdgesBySource = buildEdgesBySource(forwardEdges);
  const edgesByTarget = buildEdgesByTarget(forwardEdges);

  const state = {
    visited: new Set<string>(),
    convergenceArrivals: new Map<string, Set<string>>(),
    convergenceSkipArrivals: new Map<string, Set<string>>(),
    skippedNodes: new Set<string>(),
  };
  const tracker = createLoopBackTracker({
    maxIterationsPerLoop: options.maxIterationsPerLoop,
    maxTraversalsPerExecution: options.maxTraversalsPerExecution,
  });

  const ran: string[] = [];
  const refusals: [string, string][] = [];
  const runCounts = new Map<string, number>();

  const executeNode = (nodeId: string): void => {
    if (state.visited.has(nodeId)) {
      return;
    }
    state.visited.add(nodeId);
    ran.push(nodeId);
    const runCount = (runCounts.get(nodeId) ?? 0) + 1;
    runCounts.set(nodeId, runCount);

    const targets =
      options.route?.(nodeId, runCount) ?? edgesBySource.get(nodeId) ?? [];
    dispatch(nodeId, targets);
  };

  const dispatch = (fromNodeId: string, targets: string[]): void => {
    const forwardTargets: string[] = [];
    const loopEntryTargets: string[] = [];
    for (const target of targets) {
      if (isBackEdge(backEdgesBySource, fromNodeId, target)) {
        loopEntryTargets.push(target);
      } else {
        forwardTargets.push(target);
      }
    }

    for (const readyId of getReadyDownstreamIds(
      fromNodeId,
      forwardTargets,
      edgesByTarget,
      state.convergenceArrivals,
      state.visited
    )) {
      executeNode(readyId);
    }

    for (const loopEntryId of loopEntryTargets) {
      const body = collectReachable(loopEntryId, forwardEdgesBySource);
      const admission = tracker.admit(fromNodeId, loopEntryId, body);
      if (!admission.admitted) {
        refusals.push([fromNodeId, admission.error]);
        continue;
      }
      resetLoopBodyState(body, state);
      executeNode(loopEntryId);
    }
  };

  executeNode(startId);
  return { ran, refusals };
}

describe("loop-back dispatch", () => {
  // T -> A -> B -> {C, D}; D routes back to B until its third pass.
  const nodeIds = ["T", "A", "B", "C", "D"];
  const edges: Edge[] = [
    { source: "T", target: "A" },
    { source: "A", target: "B" },
    { source: "B", target: "C" },
    { source: "B", target: "D" },
    { source: "D", target: "B" },
  ];

  it("reaches the loop entry instead of stalling in front of it", () => {
    const { ran } = runGraph(nodeIds, edges, "T", {
      route: (nodeId) => (nodeId === "D" ? [] : undefined),
    });
    expect(ran).toEqual(["T", "A", "B", "C", "D"]);
  });

  it("runs the loop entry and everything below it again on each pass", () => {
    const { ran, refusals } = runGraph(nodeIds, edges, "T", {
      route: (nodeId, runCount) => {
        if (nodeId !== "D") {
          return;
        }
        return runCount < 3 ? ["B"] : [];
      },
    });

    expect(refusals).toEqual([]);
    expect(ran).toEqual([
      "T",
      "A",
      "B",
      "C",
      "D",
      "B",
      "C",
      "D",
      "B",
      "C",
      "D",
    ]);
    // The nodes above the loop entry run once, whatever the loop does.
    expect(ran.filter((id) => id === "T")).toHaveLength(1);
    expect(ran.filter((id) => id === "A")).toHaveLength(1);
  });

  it("stops a loop that never exits, and says which loop it was", () => {
    const { ran, refusals } = runGraph(nodeIds, edges, "T", {
      route: (nodeId) => (nodeId === "D" ? ["B"] : undefined),
      maxIterationsPerLoop: 4,
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0][0]).toBe("D");
    expect(refusals[0][1]).toContain("4 iterations");
    expect(ran.filter((id) => id === "B")).toHaveLength(5);
  });

  it("keeps a fan-in join inside the loop working on every pass", () => {
    // B forks to P and Q, which join at J; J loops back to B.
    const joinNodeIds = ["T", "B", "P", "Q", "J"];
    const joinEdges: Edge[] = [
      { source: "T", target: "B" },
      { source: "B", target: "P" },
      { source: "B", target: "Q" },
      { source: "P", target: "J" },
      { source: "Q", target: "J" },
      { source: "J", target: "B" },
    ];

    const { ran, refusals } = runGraph(joinNodeIds, joinEdges, "T", {
      route: (nodeId, runCount) => {
        if (nodeId !== "J") {
          return;
        }
        return runCount < 2 ? ["B"] : [];
      },
    });

    expect(refusals).toEqual([]);
    // J is a real join: it runs once per pass, after both branches arrive.
    expect(ran.filter((id) => id === "J")).toHaveLength(2);
    expect(ran).toEqual(["T", "B", "P", "Q", "J", "B", "P", "Q", "J"]);
  });

  it("bounds nested loops with the per-execution cap", () => {
    // Inner loop C -> B, outer loop D -> A, neither exits on its own.
    const nestedNodeIds = ["T", "A", "B", "C", "D"];
    const nestedEdges: Edge[] = [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
      { source: "B", target: "C" },
      { source: "C", target: "B" },
      { source: "C", target: "D" },
      { source: "D", target: "A" },
    ];

    const { refusals } = runGraph(nestedNodeIds, nestedEdges, "T", {
      route: (nodeId, runCount) => {
        if (nodeId === "C") {
          return runCount % 2 === 1 ? ["B"] : ["D"];
        }
        return;
      },
      maxIterationsPerLoop: 1000,
      maxTraversalsPerExecution: 12,
    });

    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.at(-1)?.[1]).toContain("12 loop iterations");
  });
});
