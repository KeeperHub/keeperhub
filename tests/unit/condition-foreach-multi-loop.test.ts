/**
 * Comprehensive tests for condition routing inside multiple For Each loops.
 *
 * Tests the real exported functions:
 *   - identifyLoopBody: builds body subgraph (bodyEdgesBySource, bodyEdgesBySourceHandle)
 *   - resolveBodyConditionTargets: determines which nodes a condition dispatches to
 *
 * Topologies tested:
 *   1. Five parallel For Each loops, each with a condition that fans out to 5 true + 5 false
 *   2. Five parallel For Each loops with chained conditions (3 deep) inside each body
 *   3. For Each with 5 parallel conditions, each having 5 true + 5 false branches
 *   4. For Each with nested conditions: outer -> 5 inner conditions on true, 5 on false
 *   5. Mixed: some conditions one-sided, varied branch counts, chained and parallel
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import {
  identifyLoopBody,
  resolveBodyConditionTargets,
} from "@/lib/workflow/executor/executor.workflow";

// Minimal WorkflowNode shape that identifyLoopBody actually reads
type TestNode = {
  id: string;
  data: {
    label: string;
    type: "trigger" | "action" | "add";
    config?: Record<string, unknown>;
  };
  position: { x: number; y: number };
};

type TestEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

let edgeCounter = 0;

function edge(source: string, target: string, sourceHandle?: string): TestEdge {
  edgeCounter++;
  return {
    id: `e-${edgeCounter}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

function actionNode(id: string, actionType?: string): TestNode {
  return {
    id,
    data: {
      label: id,
      type: "action",
      config: actionType ? { actionType } : undefined,
    },
    position: { x: 0, y: 0 },
  };
}

function conditionNode(id: string): TestNode {
  return actionNode(id, "Condition");
}

function forEachNode(id: string): TestNode {
  return actionNode(id, "For Each");
}

function collectNode(id: string): TestNode {
  return actionNode(id, "Collect");
}

/**
 * Build all the maps needed for testing from raw nodes and edges.
 * Returns the full-workflow edgesBySource, edgesBySourceHandle,
 * and a nodeMap, ready for identifyLoopBody.
 */
function buildMaps(
  nodes: TestNode[],
  edges: TestEdge[]
): {
  edgesBySource: Map<string, string[]>;
  edgesBySourceHandle: ReturnType<typeof buildEdgesBySourceHandle>;
  nodeMap: Map<string, any>;
} {
  const edgesBySource = new Map<string, string[]>();
  for (const e of edges) {
    if (!edgesBySource.has(e.source)) {
      edgesBySource.set(e.source, []);
    }
    edgesBySource.get(e.source)?.push(e.target);
  }

  const edgesBySourceHandle = buildEdgesBySourceHandle(edges);

  const nodeMap = new Map<string, TestNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  return { edgesBySource, edgesBySourceHandle, nodeMap };
}

/**
 * Generate N target node IDs with a prefix and handle, plus edges.
 * Returns { nodes, edges, ids } for the generated targets.
 */
function fanOut(
  sourceId: string,
  handle: "true" | "false",
  prefix: string,
  count: number
): { nodes: TestNode[]; edges: TestEdge[]; ids: string[] } {
  const nodes: TestNode[] = [];
  const edges: TestEdge[] = [];
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}-${handle[0]}${i}`;
    ids.push(id);
    nodes.push(actionNode(id));
    edges.push(edge(sourceId, id, handle));
  }
  return { nodes, edges, ids };
}

// -----------------------------------------------------------------------
// Topology 1: Five parallel For Each loops, each with condition (5t + 5f)
// -----------------------------------------------------------------------

describe("topology 1: five parallel For Each loops with branching conditions", () => {
  // Build the full workflow once
  const allNodes: TestNode[] = [];
  const allEdges: TestEdge[] = [];

  // For each loop index 1..5
  const loops: Array<{
    feId: string;
    collectId: string;
    condId: string;
    readId: string;
    trueIds: string[];
    falseIds: string[];
  }> = [];

  for (let i = 1; i <= 5; i++) {
    const feId = `fe-${i}`;
    const readId = `read-${i}`;
    const condId = `cond-${i}`;
    const collectId = `collect-${i}`;

    allNodes.push(forEachNode(feId));
    allNodes.push(actionNode(readId));
    allNodes.push(conditionNode(condId));
    allNodes.push(collectNode(collectId));

    // fe -> read -> cond -> collect
    allEdges.push(edge(feId, readId));
    allEdges.push(edge(readId, condId));

    // cond -> 5 true targets
    const trueFan = fanOut(condId, "true", `loop${i}`, 5);
    allNodes.push(...trueFan.nodes);
    allEdges.push(...trueFan.edges);

    // cond -> 5 false targets
    const falseFan = fanOut(condId, "false", `loop${i}`, 5);
    allNodes.push(...falseFan.nodes);
    allEdges.push(...falseFan.edges);

    // All body nodes -> collect
    for (const tid of trueFan.ids) {
      allEdges.push(edge(tid, collectId));
    }
    for (const fid of falseFan.ids) {
      allEdges.push(edge(fid, collectId));
    }

    loops.push({
      feId,
      collectId,
      condId,
      readId,
      trueIds: trueFan.ids,
      falseIds: falseFan.ids,
    });
  }

  const { edgesBySource, edgesBySourceHandle, nodeMap } = buildMaps(
    allNodes,
    allEdges
  );

  for (const loop of loops) {
    describe(`${loop.feId}: condition with 5 true + 5 false branches`, () => {
      it("should identify correct body nodes and collect boundary", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );
        expect(body.collectNodeId).toBe(loop.collectId);
        // Body should contain: read + cond + 5 true + 5 false = 12 nodes
        expect(body.bodyNodeIds).toHaveLength(12);
        expect(body.bodyNodeIds).toContain(loop.readId);
        expect(body.bodyNodeIds).toContain(loop.condId);
        for (const id of loop.trueIds) {
          expect(body.bodyNodeIds).toContain(id);
        }
        for (const id of loop.falseIds) {
          expect(body.bodyNodeIds).toContain(id);
        }
      });

      it("condition=true routes to all 5 true-branch targets", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        const targets = resolveBodyConditionTargets(
          true,
          loop.condId,
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );

        expect(targets).toHaveLength(5);
        expect(targets).toEqual(loop.trueIds);
        for (const fid of loop.falseIds) {
          expect(targets).not.toContain(fid);
        }
      });

      it("condition=false routes to all 5 false-branch targets", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        const targets = resolveBodyConditionTargets(
          false,
          loop.condId,
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );

        expect(targets).toHaveLength(5);
        expect(targets).toEqual(loop.falseIds);
        for (const tid of loop.trueIds) {
          expect(targets).not.toContain(tid);
        }
      });

      it("conditions in different loops are fully isolated", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        // Other loops' condition IDs should not be in this body
        for (const other of loops) {
          if (other.feId === loop.feId) {
            continue;
          }
          expect(body.bodyNodeIds).not.toContain(other.condId);
          for (const tid of other.trueIds) {
            expect(body.bodyNodeIds).not.toContain(tid);
          }
        }
      });
    });
  }
});

// -----------------------------------------------------------------------
// Topology 2: Five parallel For Each loops, each with 3 chained conditions
//   fe -> read -> cond-a (5t/5f) -> cond-b (5t/5f) -> cond-c (5t/5f) -> collect
// Only the true branch of each condition leads to the next condition.
// -----------------------------------------------------------------------

describe("topology 2: five For Each loops with chained conditions (3 deep, 5 branches each)", () => {
  const allNodes: TestNode[] = [];
  const allEdges: TestEdge[] = [];

  const loops: Array<{
    feId: string;
    condIds: string[];
    trueFans: string[][];
    falseFans: string[][];
  }> = [];

  for (let i = 1; i <= 5; i++) {
    const feId = `fe-${i}`;
    const readId = `read-${i}`;
    const collectId = `collect-${i}`;
    const condIds = [`cond-${i}a`, `cond-${i}b`, `cond-${i}c`];

    allNodes.push(forEachNode(feId));
    allNodes.push(actionNode(readId));
    allNodes.push(collectNode(collectId));
    for (const cid of condIds) {
      allNodes.push(conditionNode(cid));
    }

    // fe -> read -> cond-a
    allEdges.push(edge(feId, readId));
    allEdges.push(edge(readId, condIds[0]));

    const trueFans: string[][] = [];
    const falseFans: string[][] = [];

    for (let c = 0; c < condIds.length; c++) {
      const condId = condIds[c];

      // 5 false-branch targets
      const ff = fanOut(condId, "false", `l${i}c${c}`, 5);
      allNodes.push(...ff.nodes);
      allEdges.push(...ff.edges);
      falseFans.push(ff.ids);
      for (const fid of ff.ids) {
        allEdges.push(edge(fid, collectId));
      }

      if (c < condIds.length - 1) {
        // True branch of non-final conditions: 4 action targets + next condition
        const tf = fanOut(condId, "true", `l${i}c${c}`, 4);
        allNodes.push(...tf.nodes);
        allEdges.push(...tf.edges);
        // Also connect true handle to the next condition
        allEdges.push(edge(condId, condIds[c + 1], "true"));
        trueFans.push([...tf.ids, condIds[c + 1]]);
        for (const tid of tf.ids) {
          allEdges.push(edge(tid, collectId));
        }
      } else {
        // Final condition: 5 true-branch targets
        const tf = fanOut(condId, "true", `l${i}c${c}`, 5);
        allNodes.push(...tf.nodes);
        allEdges.push(...tf.edges);
        trueFans.push(tf.ids);
        for (const tid of tf.ids) {
          allEdges.push(edge(tid, collectId));
        }
      }
    }

    loops.push({ feId, condIds, trueFans, falseFans });
  }

  const { edgesBySource, edgesBySourceHandle, nodeMap } = buildMaps(
    allNodes,
    allEdges
  );

  for (const loop of loops) {
    describe(`${loop.feId}: three chained conditions`, () => {
      it("all conditions true: walks the full chain", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        for (let c = 0; c < loop.condIds.length; c++) {
          const targets = resolveBodyConditionTargets(
            true,
            loop.condIds[c],
            body.bodyEdgesBySourceHandle,
            body.bodyEdgesBySource
          );
          expect(targets).toEqual(loop.trueFans[c]);
        }
      });

      it("first condition false: nothing beyond first condition executes", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        const targets = resolveBodyConditionTargets(
          false,
          loop.condIds[0],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(targets).toEqual(loop.falseFans[0]);

        // Second and third conditions should not be in the dispatched set
        for (let c = 1; c < loop.condIds.length; c++) {
          expect(targets).not.toContain(loop.condIds[c]);
        }
      });

      it("first true, second false: chain stops at second condition", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        const firstTargets = resolveBodyConditionTargets(
          true,
          loop.condIds[0],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        // Should include next condition
        expect(firstTargets).toContain(loop.condIds[1]);

        const secondTargets = resolveBodyConditionTargets(
          false,
          loop.condIds[1],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(secondTargets).toEqual(loop.falseFans[1]);
        expect(secondTargets).not.toContain(loop.condIds[2]);
      });

      it("first true, second true, third false: only third false branch", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        const t1 = resolveBodyConditionTargets(
          true,
          loop.condIds[0],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(t1).toContain(loop.condIds[1]);

        const t2 = resolveBodyConditionTargets(
          true,
          loop.condIds[1],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(t2).toContain(loop.condIds[2]);

        const t3 = resolveBodyConditionTargets(
          false,
          loop.condIds[2],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(t3).toEqual(loop.falseFans[2]);
      });

      it("each false branch has exactly 5 targets", () => {
        const body = identifyLoopBody(
          loop.feId,
          edgesBySource,
          nodeMap,
          edgesBySourceHandle
        );

        for (const condId of loop.condIds) {
          const targets = resolveBodyConditionTargets(
            false,
            condId,
            body.bodyEdgesBySourceHandle,
            body.bodyEdgesBySource
          );
          expect(targets).toHaveLength(5);
        }
      });
    });
  }
});

// -----------------------------------------------------------------------
// Topology 3: Single For Each with 5 parallel conditions (each 5t + 5f)
//   fe -> read -> cond-1..cond-5 (all from read, each with 5t + 5f) -> collect
// -----------------------------------------------------------------------

describe("topology 3: For Each with 5 parallel conditions, each 5t + 5f", () => {
  const nodes: TestNode[] = [];
  const edges: TestEdge[] = [];

  const feId = "fe-parallel";
  const readId = "read-all";
  const collectId = "collect-all";

  nodes.push(forEachNode(feId));
  nodes.push(actionNode(readId));
  nodes.push(collectNode(collectId));

  edges.push(edge(feId, readId));

  const condData: Array<{
    condId: string;
    trueIds: string[];
    falseIds: string[];
  }> = [];

  for (let c = 1; c <= 5; c++) {
    const condId = `pcond-${c}`;
    nodes.push(conditionNode(condId));
    edges.push(edge(readId, condId));

    const tf = fanOut(condId, "true", `p${c}`, 5);
    const ff = fanOut(condId, "false", `p${c}`, 5);

    nodes.push(...tf.nodes, ...ff.nodes);
    edges.push(...tf.edges, ...ff.edges);

    for (const id of [...tf.ids, ...ff.ids]) {
      edges.push(edge(id, collectId));
    }

    condData.push({ condId, trueIds: tf.ids, falseIds: ff.ids });
  }

  const { edgesBySource, edgesBySourceHandle, nodeMap } = buildMaps(
    nodes,
    edges
  );

  it("body contains all 5 conditions and all 50 branch targets", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    // read + 5 conditions + 25 true targets + 25 false targets = 56
    expect(body.bodyNodeIds).toHaveLength(56);
    for (const cd of condData) {
      expect(body.bodyNodeIds).toContain(cd.condId);
    }
  });

  it("each condition routes independently: alternating true/false pattern", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    // Odd conditions true, even conditions false
    for (let i = 0; i < condData.length; i++) {
      const isTrue = i % 2 === 0;
      const targets = resolveBodyConditionTargets(
        isTrue,
        condData[i].condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );

      if (isTrue) {
        expect(targets).toEqual(condData[i].trueIds);
        expect(targets).toHaveLength(5);
      } else {
        expect(targets).toEqual(condData[i].falseIds);
        expect(targets).toHaveLength(5);
      }
    }
  });

  it("all conditions false: no true targets reached", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const allDispatched: string[] = [];
    for (const cd of condData) {
      const targets = resolveBodyConditionTargets(
        false,
        cd.condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      allDispatched.push(...targets);
      expect(targets).toEqual(cd.falseIds);
    }

    // No true target should appear in dispatched set
    for (const cd of condData) {
      for (const tid of cd.trueIds) {
        expect(allDispatched).not.toContain(tid);
      }
    }
  });

  it("all conditions true: no false targets reached", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const allDispatched: string[] = [];
    for (const cd of condData) {
      const targets = resolveBodyConditionTargets(
        true,
        cd.condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      allDispatched.push(...targets);
      expect(targets).toEqual(cd.trueIds);
    }

    for (const cd of condData) {
      for (const fid of cd.falseIds) {
        expect(allDispatched).not.toContain(fid);
      }
    }
  });

  it("one condition true, rest false: only that condition's true branch fires", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const activeIndex = 2;
    const allDispatched: string[] = [];

    for (let i = 0; i < condData.length; i++) {
      const isTrue = i === activeIndex;
      const targets = resolveBodyConditionTargets(
        isTrue,
        condData[i].condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      allDispatched.push(...targets);
    }

    // Only the active condition's true targets should be present
    for (const tid of condData[activeIndex].trueIds) {
      expect(allDispatched).toContain(tid);
    }
    // All other true targets should be absent
    for (let i = 0; i < condData.length; i++) {
      if (i === activeIndex) {
        continue;
      }
      for (const tid of condData[i].trueIds) {
        expect(allDispatched).not.toContain(tid);
      }
    }
  });
});

// -----------------------------------------------------------------------
// Topology 4: For Each with nested conditions
//   fe -> cond-outer (true-only)
//           true -> 5 inner conditions (each 5t + 5f)
//   collect
// When outer is false, all 5 inner conditions and their 50 targets are dead.
// -----------------------------------------------------------------------

describe("topology 4: For Each with outer gate + 5 nested inner conditions", () => {
  const nodes: TestNode[] = [];
  const edges: TestEdge[] = [];

  const feId = "fe-nested";
  const outerId = "cond-outer";
  const collectId = "collect-nested";

  nodes.push(forEachNode(feId));
  nodes.push(conditionNode(outerId));
  nodes.push(collectNode(collectId));

  edges.push(edge(feId, outerId));

  const innerConds: Array<{
    condId: string;
    trueIds: string[];
    falseIds: string[];
  }> = [];

  for (let c = 1; c <= 5; c++) {
    const condId = `inner-${c}`;
    nodes.push(conditionNode(condId));
    // Outer true -> inner condition
    edges.push(edge(outerId, condId, "true"));

    const tf = fanOut(condId, "true", `n${c}`, 5);
    const ff = fanOut(condId, "false", `n${c}`, 5);

    nodes.push(...tf.nodes, ...ff.nodes);
    edges.push(...tf.edges, ...ff.edges);

    for (const id of [...tf.ids, ...ff.ids]) {
      edges.push(edge(id, collectId));
    }

    innerConds.push({ condId, trueIds: tf.ids, falseIds: ff.ids });
  }

  // Inner condition nodes also need edges to collect
  for (const _ic of innerConds) {
    // Collect reachable from the inner condition nodes' children (already added above)
  }

  const { edgesBySource, edgesBySourceHandle, nodeMap } = buildMaps(
    nodes,
    edges
  );

  it("outer=false blocks all 5 inner conditions and all 50 targets", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const outerTargets = resolveBodyConditionTargets(
      false,
      outerId,
      body.bodyEdgesBySourceHandle,
      body.bodyEdgesBySource
    );

    expect(outerTargets).toEqual([]);
  });

  it("outer=true dispatches all 5 inner conditions", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const outerTargets = resolveBodyConditionTargets(
      true,
      outerId,
      body.bodyEdgesBySourceHandle,
      body.bodyEdgesBySource
    );

    expect(outerTargets).toHaveLength(5);
    for (const ic of innerConds) {
      expect(outerTargets).toContain(ic.condId);
    }
  });

  it("outer=true, all inner=true: only true targets fire", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const allDispatched: string[] = [];
    for (const ic of innerConds) {
      const targets = resolveBodyConditionTargets(
        true,
        ic.condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toEqual(ic.trueIds);
      expect(targets).toHaveLength(5);
      allDispatched.push(...targets);
    }

    // 25 true targets total
    expect(allDispatched).toHaveLength(25);
    for (const ic of innerConds) {
      for (const fid of ic.falseIds) {
        expect(allDispatched).not.toContain(fid);
      }
    }
  });

  it("outer=true, all inner=false: only false targets fire", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    const allDispatched: string[] = [];
    for (const ic of innerConds) {
      const targets = resolveBodyConditionTargets(
        false,
        ic.condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toEqual(ic.falseIds);
      expect(targets).toHaveLength(5);
      allDispatched.push(...targets);
    }

    expect(allDispatched).toHaveLength(25);
    for (const ic of innerConds) {
      for (const tid of ic.trueIds) {
        expect(allDispatched).not.toContain(tid);
      }
    }
  });

  it("outer=true, mixed inner results: each condition routes independently", () => {
    const body = identifyLoopBody(
      feId,
      edgesBySource,
      nodeMap,
      edgesBySourceHandle
    );

    // Pattern: true, false, true, false, true
    const pattern = [true, false, true, false, true];
    const allDispatched: string[] = [];

    for (let i = 0; i < innerConds.length; i++) {
      const targets = resolveBodyConditionTargets(
        pattern[i],
        innerConds[i].condId,
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );

      const expected = pattern[i]
        ? innerConds[i].trueIds
        : innerConds[i].falseIds;
      expect(targets).toEqual(expected);
      expect(targets).toHaveLength(5);
      allDispatched.push(...targets);

      // Verify the opposite branch is not dispatched
      const notExpected = pattern[i]
        ? innerConds[i].falseIds
        : innerConds[i].trueIds;
      for (const id of notExpected) {
        expect(targets).not.toContain(id);
      }
    }

    // 25 total: 3 conditions * 5 true + 2 conditions * 5 false
    expect(allDispatched).toHaveLength(25);
  });
});

// -----------------------------------------------------------------------
// Topology 5: Mixed topology - one-sided gates, varied branch counts,
// chained and parallel conditions inside 5 For Each loops
//
// Each loop has a different internal structure:
//   Loop 1: one-sided true gate -> 5 action targets (no false branch)
//   Loop 2: one-sided false gate -> 5 error handlers (no true branch)
//   Loop 3: chain of 5 one-sided true conditions, each with 1 side action
//   Loop 4: parallel: 3 one-sided (true-only) + 2 two-sided conditions
//   Loop 5: nested: two-sided outer (5t/5f), true side has one-sided inner (5t)
// -----------------------------------------------------------------------

describe("topology 5: mixed structures across 5 For Each loops", () => {
  // -- Loop 1: one-sided true gate -> 5 targets --
  const l1Nodes: TestNode[] = [
    forEachNode("fe-1"),
    conditionNode("l1-gate"),
    ...Array.from({ length: 5 }, (_, i) => actionNode(`l1-t${i + 1}`)),
    collectNode("collect-1"),
  ];
  const l1Edges: TestEdge[] = [
    edge("fe-1", "l1-gate"),
    ...Array.from({ length: 5 }, (_, i) =>
      edge("l1-gate", `l1-t${i + 1}`, "true")
    ),
    ...Array.from({ length: 5 }, (_, i) => edge(`l1-t${i + 1}`, "collect-1")),
  ];

  // -- Loop 2: one-sided false gate -> 5 error handlers --
  const l2Nodes: TestNode[] = [
    forEachNode("fe-2"),
    conditionNode("l2-gate"),
    ...Array.from({ length: 5 }, (_, i) => actionNode(`l2-f${i + 1}`)),
    collectNode("collect-2"),
  ];
  const l2Edges: TestEdge[] = [
    edge("fe-2", "l2-gate"),
    ...Array.from({ length: 5 }, (_, i) =>
      edge("l2-gate", `l2-f${i + 1}`, "false")
    ),
    ...Array.from({ length: 5 }, (_, i) => edge(`l2-f${i + 1}`, "collect-2")),
  ];

  // -- Loop 3: chain of 5 one-sided true conditions, each with a side action --
  const l3CondIds = Array.from({ length: 5 }, (_, i) => `l3-c${i + 1}`);
  const l3ActionIds = Array.from({ length: 5 }, (_, i) => `l3-a${i + 1}`);
  const l3Nodes: TestNode[] = [
    forEachNode("fe-3"),
    ...l3CondIds.map((id) => conditionNode(id)),
    ...l3ActionIds.map((id) => actionNode(id)),
    collectNode("collect-3"),
  ];
  const l3Edges: TestEdge[] = [
    edge("fe-3", l3CondIds[0]),
    ...l3CondIds.map((id, i) => edge(id, l3ActionIds[i], "true")),
    ...l3CondIds
      .slice(0, -1)
      .map((id, i) => edge(id, l3CondIds[i + 1], "true")),
    ...l3ActionIds.map((id) => edge(id, "collect-3")),
    edge(l3CondIds[4], "collect-3"),
  ];

  // -- Loop 4: 3 one-sided (true) + 2 two-sided conditions in parallel --
  const l4Nodes: TestNode[] = [
    forEachNode("fe-4"),
    actionNode("l4-read"),
    ...Array.from({ length: 5 }, (_, i) => conditionNode(`l4-c${i + 1}`)),
    // 3 one-sided: 5 true targets each = 15
    ...Array.from({ length: 15 }, (_, i) => actionNode(`l4-os-t${i + 1}`)),
    // 2 two-sided: 5 true + 5 false each = 20
    ...Array.from({ length: 10 }, (_, i) => actionNode(`l4-ts-t${i + 1}`)),
    ...Array.from({ length: 10 }, (_, i) => actionNode(`l4-ts-f${i + 1}`)),
    collectNode("collect-4"),
  ];
  const l4Edges: TestEdge[] = [
    edge("fe-4", "l4-read"),
    ...Array.from({ length: 5 }, (_, i) => edge("l4-read", `l4-c${i + 1}`)),
  ];
  // One-sided conditions (c1-c3): 5 true targets each
  for (let c = 0; c < 3; c++) {
    for (let t = 0; t < 5; t++) {
      const targetId = `l4-os-t${c * 5 + t + 1}`;
      l4Edges.push(edge(`l4-c${c + 1}`, targetId, "true"));
      l4Edges.push(edge(targetId, "collect-4"));
    }
  }
  // Two-sided conditions (c4-c5): 5 true + 5 false targets each
  for (let c = 0; c < 2; c++) {
    for (let t = 0; t < 5; t++) {
      const trueId = `l4-ts-t${c * 5 + t + 1}`;
      const falseId = `l4-ts-f${c * 5 + t + 1}`;
      l4Edges.push(edge(`l4-c${c + 4}`, trueId, "true"));
      l4Edges.push(edge(`l4-c${c + 4}`, falseId, "false"));
      l4Edges.push(edge(trueId, "collect-4"));
      l4Edges.push(edge(falseId, "collect-4"));
    }
  }

  // -- Loop 5: two-sided outer (5t/5f), true branch has one-sided inner (5 true targets) --
  const l5Nodes: TestNode[] = [
    forEachNode("fe-5"),
    conditionNode("l5-outer"),
    conditionNode("l5-inner"),
    ...Array.from({ length: 5 }, (_, i) => actionNode(`l5-ot${i + 1}`)),
    ...Array.from({ length: 5 }, (_, i) => actionNode(`l5-of${i + 1}`)),
    ...Array.from({ length: 5 }, (_, i) => actionNode(`l5-it${i + 1}`)),
    collectNode("collect-5"),
  ];
  const l5Edges: TestEdge[] = [
    edge("fe-5", "l5-outer"),
    // outer true: 4 actions + inner condition
    ...Array.from({ length: 4 }, (_, i) =>
      edge("l5-outer", `l5-ot${i + 1}`, "true")
    ),
    edge("l5-outer", "l5-inner", "true"),
    // outer false: 5 actions
    ...Array.from({ length: 5 }, (_, i) =>
      edge("l5-outer", `l5-of${i + 1}`, "false")
    ),
    // inner true: 5 actions (one-sided, no false branch)
    ...Array.from({ length: 5 }, (_, i) =>
      edge("l5-inner", `l5-it${i + 1}`, "true")
    ),
    // Connect everything to collect
    ...Array.from({ length: 5 }, (_, i) => edge(`l5-ot${i + 1}`, "collect-5")),
    ...Array.from({ length: 5 }, (_, i) => edge(`l5-of${i + 1}`, "collect-5")),
    ...Array.from({ length: 5 }, (_, i) => edge(`l5-it${i + 1}`, "collect-5")),
    edge("l5-inner", "collect-5"),
  ];

  const allNodes = [...l1Nodes, ...l2Nodes, ...l3Nodes, ...l4Nodes, ...l5Nodes];
  const allEdges = [...l1Edges, ...l2Edges, ...l3Edges, ...l4Edges, ...l5Edges];
  const { edgesBySource, edgesBySourceHandle, nodeMap } = buildMaps(
    allNodes,
    allEdges
  );

  describe("loop 1: one-sided true gate", () => {
    it("true dispatches all 5 targets", () => {
      const body = identifyLoopBody(
        "fe-1",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );
      const targets = resolveBodyConditionTargets(
        true,
        "l1-gate",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toHaveLength(5);
      for (let i = 1; i <= 5; i++) {
        expect(targets).toContain(`l1-t${i}`);
      }
    });

    it("false dispatches nothing", () => {
      const body = identifyLoopBody(
        "fe-1",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );
      const targets = resolveBodyConditionTargets(
        false,
        "l1-gate",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });
  });

  describe("loop 2: one-sided false gate", () => {
    it("false dispatches all 5 error handlers", () => {
      const body = identifyLoopBody(
        "fe-2",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );
      const targets = resolveBodyConditionTargets(
        false,
        "l2-gate",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toHaveLength(5);
      for (let i = 1; i <= 5; i++) {
        expect(targets).toContain(`l2-f${i}`);
      }
    });

    it("true dispatches nothing", () => {
      const body = identifyLoopBody(
        "fe-2",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );
      const targets = resolveBodyConditionTargets(
        true,
        "l2-gate",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });
  });

  describe("loop 3: chain of 5 one-sided true conditions", () => {
    it("all true: every condition dispatches its side action and next condition", () => {
      const body = identifyLoopBody(
        "fe-3",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      for (let i = 0; i < 5; i++) {
        const targets = resolveBodyConditionTargets(
          true,
          l3CondIds[i],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(targets).toContain(l3ActionIds[i]);
        if (i < 4) {
          expect(targets).toContain(l3CondIds[i + 1]);
        }
      }
    });

    it("false at position 0: entire chain is dead", () => {
      const body = identifyLoopBody(
        "fe-3",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );
      const targets = resolveBodyConditionTargets(
        false,
        l3CondIds[0],
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(targets).toEqual([]);
    });

    it("false at position 2: first two conditions dispatch, rest dead", () => {
      const body = identifyLoopBody(
        "fe-3",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const t0 = resolveBodyConditionTargets(
        true,
        l3CondIds[0],
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(t0).toContain(l3CondIds[1]);

      const t1 = resolveBodyConditionTargets(
        true,
        l3CondIds[1],
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(t1).toContain(l3CondIds[2]);

      const t2 = resolveBodyConditionTargets(
        false,
        l3CondIds[2],
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(t2).toEqual([]);
    });

    it("false at position 4 (last): first four dispatch, last blocks", () => {
      const body = identifyLoopBody(
        "fe-3",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      for (let i = 0; i < 4; i++) {
        const t = resolveBodyConditionTargets(
          true,
          l3CondIds[i],
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(t).toContain(l3ActionIds[i]);
        expect(t).toContain(l3CondIds[i + 1]);
      }

      const tLast = resolveBodyConditionTargets(
        false,
        l3CondIds[4],
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(tLast).toEqual([]);
    });
  });

  describe("loop 4: 3 one-sided + 2 two-sided conditions in parallel", () => {
    it("all one-sided conditions false: no one-sided targets fire", () => {
      const body = identifyLoopBody(
        "fe-4",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      for (let c = 1; c <= 3; c++) {
        const targets = resolveBodyConditionTargets(
          false,
          `l4-c${c}`,
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(targets).toEqual([]);
      }
    });

    it("all one-sided conditions true: 15 targets fire", () => {
      const body = identifyLoopBody(
        "fe-4",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const allTargets: string[] = [];
      for (let c = 1; c <= 3; c++) {
        const targets = resolveBodyConditionTargets(
          true,
          `l4-c${c}`,
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(targets).toHaveLength(5);
        allTargets.push(...targets);
      }
      expect(allTargets).toHaveLength(15);
    });

    it("two-sided c4=true, c5=false: correct targets for each", () => {
      const body = identifyLoopBody(
        "fe-4",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const c4Targets = resolveBodyConditionTargets(
        true,
        "l4-c4",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(c4Targets).toHaveLength(5);
      for (let t = 1; t <= 5; t++) {
        expect(c4Targets).toContain(`l4-ts-t${t}`);
      }

      const c5Targets = resolveBodyConditionTargets(
        false,
        "l4-c5",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(c5Targets).toHaveLength(5);
      for (let t = 6; t <= 10; t++) {
        expect(c5Targets).toContain(`l4-ts-f${t}`);
      }
    });

    it("two-sided c4=false, c5=true: correct targets for each", () => {
      const body = identifyLoopBody(
        "fe-4",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const c4Targets = resolveBodyConditionTargets(
        false,
        "l4-c4",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(c4Targets).toHaveLength(5);
      for (let t = 1; t <= 5; t++) {
        expect(c4Targets).toContain(`l4-ts-f${t}`);
      }

      const c5Targets = resolveBodyConditionTargets(
        true,
        "l4-c5",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(c5Targets).toHaveLength(5);
      for (let t = 6; t <= 10; t++) {
        expect(c5Targets).toContain(`l4-ts-t${t}`);
      }
    });

    it("mixed: one-sided all false, two-sided all true: only two-sided true branches fire", () => {
      const body = identifyLoopBody(
        "fe-4",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const allDispatched: string[] = [];

      for (let c = 1; c <= 3; c++) {
        const targets = resolveBodyConditionTargets(
          false,
          `l4-c${c}`,
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(targets).toEqual([]);
      }

      for (let c = 4; c <= 5; c++) {
        const targets = resolveBodyConditionTargets(
          true,
          `l4-c${c}`,
          body.bodyEdgesBySourceHandle,
          body.bodyEdgesBySource
        );
        expect(targets).toHaveLength(5);
        allDispatched.push(...targets);
      }

      expect(allDispatched).toHaveLength(10);
      // Verify no false targets from two-sided conditions
      for (let i = 1; i <= 10; i++) {
        expect(allDispatched).not.toContain(`l4-ts-f${i}`);
      }
    });
  });

  describe("loop 5: two-sided outer + one-sided inner on true branch", () => {
    it("outer=false: 5 false targets, inner never reached", () => {
      const body = identifyLoopBody(
        "fe-5",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const outerTargets = resolveBodyConditionTargets(
        false,
        "l5-outer",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(outerTargets).toHaveLength(5);
      for (let i = 1; i <= 5; i++) {
        expect(outerTargets).toContain(`l5-of${i}`);
      }
      expect(outerTargets).not.toContain("l5-inner");
    });

    it("outer=true: 4 true actions + inner condition dispatched", () => {
      const body = identifyLoopBody(
        "fe-5",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const outerTargets = resolveBodyConditionTargets(
        true,
        "l5-outer",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(outerTargets).toHaveLength(5);
      for (let i = 1; i <= 4; i++) {
        expect(outerTargets).toContain(`l5-ot${i}`);
      }
      expect(outerTargets).toContain("l5-inner");

      // No false targets
      for (let i = 1; i <= 5; i++) {
        expect(outerTargets).not.toContain(`l5-of${i}`);
      }
    });

    it("outer=true, inner=true: inner dispatches 5 targets", () => {
      const body = identifyLoopBody(
        "fe-5",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const innerTargets = resolveBodyConditionTargets(
        true,
        "l5-inner",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(innerTargets).toHaveLength(5);
      for (let i = 1; i <= 5; i++) {
        expect(innerTargets).toContain(`l5-it${i}`);
      }
    });

    it("outer=true, inner=false: inner dispatches nothing (one-sided)", () => {
      const body = identifyLoopBody(
        "fe-5",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const innerTargets = resolveBodyConditionTargets(
        false,
        "l5-inner",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      expect(innerTargets).toEqual([]);
    });

    it("full walk outer=true inner=true: correct total dispatched set", () => {
      const body = identifyLoopBody(
        "fe-5",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const outerTargets = resolveBodyConditionTargets(
        true,
        "l5-outer",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );
      const innerTargets = resolveBodyConditionTargets(
        true,
        "l5-inner",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );

      const allDispatched = new Set([...outerTargets, ...innerTargets]);
      // 4 outer-true actions + inner condition + 5 inner-true actions = 10
      expect(allDispatched.size).toBe(10);

      // No outer-false targets
      for (let i = 1; i <= 5; i++) {
        expect(allDispatched.has(`l5-of${i}`)).toBe(false);
      }
    });

    it("full walk outer=false: zero nodes beyond outer false targets", () => {
      const body = identifyLoopBody(
        "fe-5",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      const outerTargets = resolveBodyConditionTargets(
        false,
        "l5-outer",
        body.bodyEdgesBySourceHandle,
        body.bodyEdgesBySource
      );

      const allDispatched = new Set(outerTargets);
      expect(allDispatched.size).toBe(5);

      // No true targets, no inner targets
      for (let i = 1; i <= 5; i++) {
        expect(allDispatched.has(`l5-ot${i}`)).toBe(false);
        expect(allDispatched.has(`l5-it${i}`)).toBe(false);
      }
      expect(allDispatched.has("l5-inner")).toBe(false);
    });
  });

  describe("cross-loop isolation", () => {
    it("each loop body contains only its own nodes", () => {
      const feIds = ["fe-1", "fe-2", "fe-3", "fe-4", "fe-5"];
      const bodies = feIds.map((feId) =>
        identifyLoopBody(feId, edgesBySource, nodeMap, edgesBySourceHandle)
      );

      for (let i = 0; i < bodies.length; i++) {
        const bodySet = new Set(bodies[i].bodyNodeIds);
        for (let j = 0; j < bodies.length; j++) {
          if (i === j) {
            continue;
          }
          for (const nodeId of bodies[j].bodyNodeIds) {
            expect(bodySet.has(nodeId)).toBe(false);
          }
        }
      }
    });

    it("condition decisions in one loop do not affect another loop's routing", () => {
      const body1 = identifyLoopBody(
        "fe-1",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );
      const body2 = identifyLoopBody(
        "fe-2",
        edgesBySource,
        nodeMap,
        edgesBySourceHandle
      );

      // Loop 1 gate = false (nothing dispatched)
      const l1Targets = resolveBodyConditionTargets(
        false,
        "l1-gate",
        body1.bodyEdgesBySourceHandle,
        body1.bodyEdgesBySource
      );
      expect(l1Targets).toEqual([]);

      // Loop 2 gate = false (5 error handlers dispatched)
      const l2Targets = resolveBodyConditionTargets(
        false,
        "l2-gate",
        body2.bodyEdgesBySourceHandle,
        body2.bodyEdgesBySource
      );
      expect(l2Targets).toHaveLength(5);

      // They should share zero node IDs
      const l1Set = new Set(l1Targets);
      for (const id of l2Targets) {
        expect(l1Set.has(id)).toBe(false);
      }
    });
  });
});
