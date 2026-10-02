import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectReachable,
  findBackEdges,
  isBackEdge,
  partitionByBackEdges,
} from "@/lib/workflow/editor/back-edges";
import {
  buildEdgesBySource,
  buildEdgesByTarget,
  getReadyDownstreamIds,
} from "@/lib/workflow/executor/convergence-barrier";

const nodes = (...ids: string[]): Array<{ id: string }> =>
  ids.map((id) => ({ id }));

describe("findBackEdges", () => {
  it("finds nothing in a plain chain", () => {
    const found = findBackEdges(nodes("T", "A", "B"), [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
    ]);
    expect(found.size).toBe(0);
  });

  it("finds nothing in a fork-join diamond", () => {
    const found = findBackEdges(nodes("T", "A", "B", "C", "D"), [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "B", target: "D" },
      { source: "C", target: "D" },
    ]);
    expect(found.size).toBe(0);
  });

  it("classifies the edge that points back at an ancestor", () => {
    const found = findBackEdges(nodes("T", "A", "B", "C", "D"), [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
      { source: "B", target: "C" },
      { source: "B", target: "D" },
      { source: "D", target: "B" },
    ]);
    expect(isBackEdge(found, "D", "B")).toBe(true);
    expect(isBackEdge(found, "A", "B")).toBe(false);
    expect(found.size).toBe(1);
  });

  it("classifies a self edge", () => {
    const found = findBackEdges(nodes("A"), [{ source: "A", target: "A" }]);
    expect(isBackEdge(found, "A", "A")).toBe(true);
  });

  it("classifies one edge per nested loop", () => {
    const found = findBackEdges(nodes("T", "A", "B", "C"), [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
      { source: "B", target: "C" },
      { source: "C", target: "B" },
      { source: "C", target: "A" },
    ]);
    expect(isBackEdge(found, "C", "B")).toBe(true);
    expect(isBackEdge(found, "C", "A")).toBe(true);
  });

  it("classifies a cycle no root reaches", () => {
    const found = findBackEdges(nodes("T", "A", "X", "Y"), [
      { source: "T", target: "A" },
      { source: "X", target: "Y" },
      { source: "Y", target: "X" },
    ]);
    expect(found.size).toBe(1);
    expect(isBackEdge(found, "Y", "X")).toBe(true);
  });

  it("is stable across repeated calls on the same graph", () => {
    const graph = nodes("T", "A", "B", "C");
    const edges = [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
      { source: "B", target: "C" },
      { source: "C", target: "A" },
    ];
    const first = findBackEdges(graph, edges);
    const second = findBackEdges(graph, edges);
    expect([...second.keys()]).toEqual([...first.keys()]);
  });
});

describe("partitionByBackEdges", () => {
  it("returns the original array when the graph is acyclic", () => {
    const edges = [
      { source: "T", target: "A" },
      { source: "A", target: "B" },
    ];
    const partition = partitionByBackEdges(nodes("T", "A", "B"), edges);
    expect(partition.forwardEdges).toBe(edges);
    expect(partition.backEdges).toEqual([]);
  });

  it("separates the loop edge and keeps the rest forward", () => {
    const { forwardEdges, backEdges } = partitionByBackEdges(
      nodes("T", "A", "B", "C"),
      [
        { source: "T", target: "A" },
        { source: "A", target: "B" },
        { source: "B", target: "C" },
        { source: "C", target: "B" },
      ]
    );
    expect(backEdges).toEqual([{ source: "C", target: "B" }]);
    expect(forwardEdges).toHaveLength(3);
  });

  it("keeps both parallel edges between a pair together", () => {
    const { backEdges } = partitionByBackEdges(nodes("A", "B"), [
      { source: "A", target: "B" },
      { source: "B", target: "A", sourceHandle: "true" },
      { source: "B", target: "A", sourceHandle: "false" },
    ]);
    expect(backEdges).toHaveLength(2);
  });
});

describe("convergence barrier over the forward DAG", () => {
  // The bug the loop support exists to fix: a back edge into B raises B's
  // in-degree to 2, so the barrier holds B for an arrival only B can produce.
  const graph = nodes("T", "A", "B", "C", "D");
  const edges = [
    { source: "T", target: "A" },
    { source: "A", target: "B" },
    { source: "B", target: "C" },
    { source: "B", target: "D" },
    { source: "D", target: "B" },
  ];

  it("stalls at the loop entry when back edges count toward in-degree", () => {
    const ready = getReadyDownstreamIds(
      "A",
      ["B"],
      buildEdgesByTarget(edges),
      new Map(),
      new Set()
    );
    expect(ready).toEqual([]);
  });

  it("releases the loop entry once back edges are excluded", () => {
    const { forwardEdges } = partitionByBackEdges(graph, edges);
    const ready = getReadyDownstreamIds(
      "A",
      ["B"],
      buildEdgesByTarget(forwardEdges),
      new Map(),
      new Set()
    );
    expect(ready).toEqual(["B"]);
  });

  it("still holds a genuine fan-in join that also carries a back edge", () => {
    const joinNodes = nodes("T", "A", "B", "J", "E");
    const joinEdges = [
      { source: "T", target: "A" },
      { source: "T", target: "B" },
      { source: "A", target: "J" },
      { source: "B", target: "J" },
      { source: "J", target: "E" },
      { source: "E", target: "J" },
    ];
    const { forwardEdges } = partitionByBackEdges(joinNodes, joinEdges);
    const byTarget = buildEdgesByTarget(forwardEdges);
    const arrivals = new Map<string, Set<string>>();
    const visited = new Set<string>();

    expect(
      getReadyDownstreamIds("A", ["J"], byTarget, arrivals, visited)
    ).toEqual([]);
    expect(
      getReadyDownstreamIds("B", ["J"], byTarget, arrivals, visited)
    ).toEqual(["J"]);
  });
});

describe("collectReachable", () => {
  it("returns the start node and everything it feeds", () => {
    const { forwardEdges } = partitionByBackEdges(
      nodes("T", "A", "B", "C", "D"),
      [
        { source: "T", target: "A" },
        { source: "A", target: "B" },
        { source: "B", target: "C" },
        { source: "B", target: "D" },
        { source: "D", target: "B" },
      ]
    );
    const reachable = collectReachable("B", buildEdgesBySource(forwardEdges));
    expect([...reachable].sort()).toEqual(["B", "C", "D"]);
  });

  it("terminates on a graph whose forward map still holds a cycle", () => {
    const edgesBySource = buildEdgesBySource([
      { source: "A", target: "B" },
      { source: "B", target: "A" },
    ]);
    expect([...collectReachable("A", edgesBySource)].sort()).toEqual([
      "A",
      "B",
    ]);
  });
});
