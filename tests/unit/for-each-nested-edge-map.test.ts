/**
 * Regression tests for issue #2049:
 *   "Condition node never executes when nested inside two For Each loops
 *    (nested loop edge-map bug)"
 *
 * Root cause: handleForEachExecution's handleNestedForEach callback forwarded
 * the *outer* loop's own locally-scoped `bodyEdgesBySource` to the recursive
 * inner-loop call. The outer BFS intentionally does not walk into a nested
 * For Each's `loop` branch, so that map has no entry for any edge living
 * purely inside the inner body (e.g. `read-contributed ->
 * condition-not-contributed`). The inner body-scan saw zero downstream
 * targets past its seed and silently terminated, leaving the Condition node
 * absent from the execution trace.
 *
 * The executor does not call `resolveNestedForEachEdgeMap`; it passes the
 * workflow-global map to `identifyLoopBody` directly. So these tests cover
 * `identifyLoopBody`, not the executor: they pin its behaviour on the 2-level
 * and 3-level topologies below, running each nested scan on the map the
 * resolver returns so the map under test is named explicitly. The depth-3
 * root-cause case demonstrates the mechanism directly: it chains each level's
 * own partial map and asserts the depth-3 body is lost.
 *
 * Not covered here: no test drives `executeWorkflow`, so the executor's own
 * map choice at its `identifyLoopBody` call is outside this file.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import {
  identifyLoopBody,
  resolveNestedForEachEdgeMap,
} from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Minimal node / edge factory helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, actionType: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType },
    },
  };
}

type RawEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

let _edgeSeq = 0;
function makeEdge(
  source: string,
  target: string,
  sourceHandle?: string
): RawEdge {
  return {
    id: `e${++_edgeSeq}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

function buildNodeMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// ---------------------------------------------------------------------------
// Shared workflow topology (mirrors the real failing workflow from issue #2049)
//
//   for-each-circles  (outer For Each)
//     +- condition-due           (Condition at depth-1 — gates the inner loop)
//          +- (true) for-each-members
//     +- for-each-members        (inner For Each — nested)
//          +- read-contributed   (depth-2 seed node)
//          +- condition-not-contributed  (Condition at depth-2 — THE BUG)
//          +- write-deposit-draw         (depth-2 action)
//          +- collect-members            (terminates inner body)
//     +- collect-circles         (terminates outer body)
// ---------------------------------------------------------------------------

const ALL_NODES: WorkflowNode[] = [
  makeNode("for-each-circles", "For Each"),
  makeNode("condition-due", "Condition"),
  makeNode("for-each-members", "For Each"),
  makeNode("read-contributed", "Read Contract"),
  makeNode("condition-not-contributed", "Condition"),
  makeNode("write-deposit-draw", "Write Contract"),
  makeNode("collect-members", "Collect"),
  makeNode("collect-circles", "Collect"),
];

const ALL_EDGES: RawEdge[] = [
  // Outer body edges
  makeEdge("for-each-circles", "condition-due", "loop"),
  makeEdge("for-each-circles", "for-each-members", "loop"),
  makeEdge("for-each-circles", "collect-circles", "done"),
  makeEdge("condition-due", "for-each-members", "true"),
  // Inner body edges — live PURELY inside the inner loop
  makeEdge("for-each-members", "read-contributed", "loop"),
  makeEdge("for-each-members", "collect-members", "done"),
  makeEdge("read-contributed", "condition-not-contributed"),
  makeEdge("condition-not-contributed", "write-deposit-draw", "true"),
  makeEdge("write-deposit-draw", "collect-members"),
  // Done-chain exits inner loop
  makeEdge("collect-members", "collect-circles"),
];

const GLOBAL_EDGES_BY_SOURCE = buildEdgesBySource(ALL_EDGES);
const GLOBAL_EDGES_BY_SOURCE_HANDLE = buildEdgesBySourceHandle(ALL_EDGES);
const NODE_MAP = buildNodeMap(ALL_NODES);

// ---------------------------------------------------------------------------
// Outer loop body identification (baseline — must always pass)
// ---------------------------------------------------------------------------

describe("outer For Each body identification (baseline)", () => {
  it("finds the outer body correctly using the global edge map", () => {
    const outerBody = identifyLoopBody(
      "for-each-circles",
      GLOBAL_EDGES_BY_SOURCE,
      NODE_MAP,
      GLOBAL_EDGES_BY_SOURCE_HANDLE
    );

    expect(outerBody.bodyNodeIds).toContain("for-each-members");
    expect(outerBody.bodyNodeIds).toContain("condition-due");
    expect(outerBody.collectNodeId).toBe("collect-circles");
    expect(outerBody.bodyNodeIds).not.toContain("collect-circles");
  });
});

// ---------------------------------------------------------------------------
// Core regression: inner For Each body - nested edge-map handoff (issue #2049)
// ---------------------------------------------------------------------------

describe("inner For Each body identification — nested edge-map handoff (issue #2049)", () => {
  // The outer scan, exactly as the executor runs it. Its bodyEdgesBySource is
  // the partial map the old code forwarded to the nested call.
  const outerBody = identifyLoopBody(
    "for-each-circles",
    GLOBAL_EDGES_BY_SOURCE,
    NODE_MAP,
    GLOBAL_EDGES_BY_SOURCE_HANDLE
  );

  // The handoff itself. Every assertion below scans the inner loop with
  // whatever this returns, so returning the outer map fails this suite.
  const innerBody = identifyLoopBody(
    "for-each-members",
    resolveNestedForEachEdgeMap({
      globalEdgesBySource: GLOBAL_EDGES_BY_SOURCE,
      outerBodyEdgesBySource: outerBody.bodyEdgesBySource,
    }),
    NODE_MAP,
    GLOBAL_EDGES_BY_SOURCE_HANDLE
  );

  it("the outer scan never descends into the inner loop's body", () => {
    // Why the outer map cannot serve the nested scan: it has no entry for any
    // edge that lives purely inside the inner loop.
    expect(outerBody.bodyEdgesBySource.has("read-contributed")).toBe(false);
    expect(outerBody.bodyNodeIds).not.toContain("condition-not-contributed");
  });

  it("the resolved map exposes every inner-body node past the seed", () => {
    expect(innerBody.bodyNodeIds).toContain("read-contributed");
    expect(innerBody.bodyNodeIds).toContain("condition-not-contributed");
    expect(innerBody.bodyNodeIds).toContain("write-deposit-draw");
    expect(innerBody.collectNodeId).toBe("collect-members");
    expect(innerBody.bodyNodeIds).not.toContain("collect-members");
  });

  it("the inner body map carries the edge that was silently absent before", () => {
    expect(innerBody.bodyEdgesBySource.get("read-contributed")).toContain(
      "condition-not-contributed"
    );
  });
});

// ---------------------------------------------------------------------------
// Generalisation: 3-level nesting — same fix applies at every recursion depth
// ---------------------------------------------------------------------------

describe("3-level nesting: the resolver holds at every recursion depth", () => {
  //   fe-l1 -> fe-l2 -> fe-l3 -> read-data -> condition-deep
  //                                          -> (true) write-result -> collect-l3
  //   collect-l3 -> collect-l2 -> collect-l1

  const nodes3: WorkflowNode[] = [
    makeNode("fe-l1", "For Each"),
    makeNode("fe-l2", "For Each"),
    makeNode("fe-l3", "For Each"),
    makeNode("read-data", "Read Contract"),
    makeNode("condition-deep", "Condition"),
    makeNode("write-result", "Write Contract"),
    makeNode("collect-l3", "Collect"),
    makeNode("collect-l2", "Collect"),
    makeNode("collect-l1", "Collect"),
  ];

  const edges3: RawEdge[] = [
    makeEdge("fe-l1", "fe-l2", "loop"),
    makeEdge("fe-l1", "collect-l1", "done"),
    makeEdge("fe-l2", "fe-l3", "loop"),
    makeEdge("fe-l2", "collect-l2", "done"),
    makeEdge("fe-l3", "read-data", "loop"),
    makeEdge("fe-l3", "collect-l3", "done"),
    makeEdge("read-data", "condition-deep"),
    makeEdge("condition-deep", "write-result", "true"),
    makeEdge("write-result", "collect-l3"),
    makeEdge("collect-l3", "collect-l2"),
    makeEdge("collect-l2", "collect-l1"),
  ];

  const global3 = buildEdgesBySource(edges3);
  const globalHandle3 = buildEdgesBySourceHandle(edges3);
  const nodeMap3 = buildNodeMap(nodes3);

  it("depth-3 body is complete when each level resolves its nested map", () => {
    // The executor's recursion, level by level: every nested scan runs on
    // whatever resolveNestedForEachEdgeMap hands back.
    const l1Body = identifyLoopBody("fe-l1", global3, nodeMap3, globalHandle3);
    const l2Body = identifyLoopBody(
      "fe-l2",
      resolveNestedForEachEdgeMap({
        globalEdgesBySource: global3,
        outerBodyEdgesBySource: l1Body.bodyEdgesBySource,
      }),
      nodeMap3,
      globalHandle3
    );
    const l3Body = identifyLoopBody(
      "fe-l3",
      resolveNestedForEachEdgeMap({
        globalEdgesBySource: global3,
        outerBodyEdgesBySource: l2Body.bodyEdgesBySource,
      }),
      nodeMap3,
      globalHandle3
    );

    expect(l3Body.bodyNodeIds).toContain("read-data");
    expect(l3Body.bodyNodeIds).toContain("condition-deep");
    expect(l3Body.bodyNodeIds).toContain("write-result");
    expect(l3Body.collectNodeId).toBe("collect-l3");
  });

  it("chaining each level's own partial map loses the depth-3 body (root cause)", () => {
    const l1Body = identifyLoopBody("fe-l1", global3, nodeMap3, globalHandle3);
    const l2Body = identifyLoopBody(
      "fe-l2",
      l1Body.bodyEdgesBySource,
      nodeMap3,
      globalHandle3
    );
    const l3Body = identifyLoopBody(
      "fe-l3",
      l2Body.bodyEdgesBySource,
      nodeMap3,
      globalHandle3
    );

    expect(l3Body.bodyNodeIds).not.toContain("condition-deep");
    expect(l3Body.bodyNodeIds).not.toContain("write-result");
  });
});
