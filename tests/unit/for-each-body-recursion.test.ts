/**
 * Comprehensive recursion tests for the For Each body executor.
 *
 * Reproduces the real-world Autoline Job Keeper workflow shape that exposed
 * a downstream-action-skip bug:
 *
 *   For Each -> Sequencer (action) -> Condition (true)
 *               -> AutoLineJob (action) -> Decode (action) -> ...
 *
 * Production execution `2vv25od6mwq7etx68isv0` ran AutoLineJob successfully
 * and then silently dropped the rest of the branch, even though the next
 * edge has no condition and the node returned success: true. Top-level run
 * status was "success" with no error logged.
 *
 * These tests drive a faithful re-implementation of `executeBodyNode` using
 * the real exported helpers (identifyLoopBody, resolveBodyConditionTargets)
 * to confirm the routing decisions land on the expected nodes for every
 * topology the engine has to support inside a parallel For Each iteration.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import {
  identifyLoopBody,
  resolveBodyConditionTargets,
} from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

type ActionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type StepRunner = (params: {
  nodeId: string;
  actionType: string;
}) => Promise<ActionResult>;

type SimulationOptions = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  forEachNodeId: string;
  items: unknown[];
  runStep: StepRunner;
};

type SimulationResult = {
  /** Order in which body steps were invoked across all iterations. */
  visitOrder: Array<{ iterationIndex: number; nodeId: string }>;
  /** Whether each iteration visited each node at least once. */
  perIteration: Set<string>[];
};

function action(id: string, actionType: string, label?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: label ?? id,
      config: { actionType },
    },
  };
}

function condition(id: string, label?: string): WorkflowNode {
  return action(id, "Condition", label);
}

function forEach(id: string, label?: string): WorkflowNode {
  return action(id, "For Each", label);
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return {
    id: `${source}->${target}${sourceHandle ? `#${sourceHandle}` : ""}`,
    source,
    target,
    type: "default",
    ...(sourceHandle ? { sourceHandle } : {}),
  };
}

/**
 * Faithful re-implementation of executor.workflow.ts `executeBodyNode`
 * recursion. Tracks visit order and per-iteration node visits.
 *
 * Mirrors:
 *   lib/workflow/executor/executor.workflow.ts:1241  executeBodyNode
 *
 * Contract this asserts the executor must honor:
 * 1. After a successful non-Condition action, every target in
 *    bodyEdgesBySource[node] must be visited once.
 * 2. After a Condition, only the targets returned by
 *    resolveBodyConditionTargets must be visited.
 * 3. A node is visited at most once per iteration (bodyVisited set).
 */
async function simulate(options: SimulationOptions): Promise<SimulationResult> {
  const { nodes, edges, forEachNodeId, items, runStep } = options;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = buildEdgesBySource(edges);
  const fullHandleMap = buildEdgesBySourceHandle(edges);

  const { collectNodeId, bodyEdgesBySource, bodyEdgesBySourceHandle } =
    identifyLoopBody(forEachNodeId, edgesBySource, nodeMap, fullHandleMap);

  const visitOrder: Array<{ iterationIndex: number; nodeId: string }> = [];
  const perIteration: Set<string>[] = [];

  async function executeBodyNode(
    nodeId: string,
    iterationIndex: number,
    bodyVisited: Set<string>
  ): Promise<void> {
    if (bodyVisited.has(nodeId)) {
      return;
    }
    if (nodeId === collectNodeId) {
      return;
    }
    bodyVisited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    const actionType = node.data.config?.actionType as string | undefined;
    if (!actionType) {
      return;
    }

    visitOrder.push({ iterationIndex, nodeId });
    perIteration[iterationIndex].add(nodeId);

    const result = await runStep({ nodeId, actionType });
    if (!result.success) {
      return;
    }

    if (actionType === "Condition") {
      const conditionValue = (result.data as { condition?: boolean })
        ?.condition;
      const conditionTargets = resolveBodyConditionTargets(
        conditionValue === true,
        nodeId,
        bodyEdgesBySourceHandle,
        bodyEdgesBySource
      );
      for (const next of conditionTargets) {
        await executeBodyNode(next, iterationIndex, bodyVisited);
      }
      return;
    }

    if (actionType === "For Each") {
      // Nested For Each: iterate over a fresh sub-array (test-only stub).
      // The real executor calls handleForEachExecution; we just ensure the
      // post-iteration continuation still fires for the parent.
      const nestedItems = (result.data as { items?: unknown[] })?.items ?? [];
      for (const _item of nestedItems) {
        // No-op: we do not recurse into nested bodies in the simulator.
      }
      // Non-nested behaviour: proceed to downstream targets, mirroring the
      // current executor which also walks bodyEdgesBySource for For Each.
    }

    const nextNodes = bodyEdgesBySource.get(nodeId) ?? [];
    for (const next of nextNodes) {
      await executeBodyNode(next, iterationIndex, bodyVisited);
    }
  }

  for (let i = 0; i < items.length; i += 1) {
    perIteration.push(new Set<string>());
    const bodyVisited = new Set<string>();
    const firstBodyNodes = bodyEdgesBySource.get(forEachNodeId) ?? [];
    for (const bodyNodeId of firstBodyNodes) {
      await executeBodyNode(bodyNodeId, i, bodyVisited);
    }
  }

  return { visitOrder, perIteration };
}

// ---------------------------------------------------------------------------
// Autoline Job Keeper shape: action -> condition(true) -> action -> action -> ...
// ---------------------------------------------------------------------------

describe("For Each body recursion: action -> condition -> action -> action chain", () => {
  // Mirrors workflow ad25gf7g1pmmgmcuze96m (Autoline Job Keeper).
  // For Each -> Sequencer (read) -> Condition true -> AutoLineJob (read)
  //   -> Decode (run-code) -> IF workable (cond) -> [Discord (false), DssAutoLine (true)]
  //   DssAutoLine -> Condition -> Work (write)
  const nodes = [
    forEach("for-each"),
    action("sequencer", "web3/read-contract", "Sequencer"),
    condition("c-master", "Sequencer is master?"),
    action("autoline", "web3/read-contract", "AutoLineJob initial check"),
    action("decode", "code/run-code", "Decode autoline output"),
    condition("c-workable", "IF workable is true"),
    action("discord", "discord/send-message", "Notify"),
    action("dssAutoLine", "web3/read-contract", "DssAutoLine"),
    condition("c-line", "line != 0"),
    action("work", "web3/write-contract", "Call work()"),
  ];

  const edges = [
    edge("for-each", "sequencer", "loop"),
    edge("sequencer", "c-master"),
    edge("c-master", "autoline", "true"),
    edge("autoline", "decode"),
    edge("decode", "c-workable"),
    edge("c-workable", "discord", "false"),
    edge("c-workable", "dssAutoLine", "true"),
    edge("dssAutoLine", "c-line"),
    edge("c-line", "work", "true"),
  ];

  it("visits every downstream node when the master condition is true and workable=true", async () => {
    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: ["MAKER"],
      runStep: async ({ nodeId, actionType }) => {
        if (actionType === "Condition") {
          // master? = true, workable? = true, line? = true
          return { success: true, data: { condition: true } };
        }
        if (nodeId === "autoline") {
          return {
            success: true,
            data: { result: { unnamedOutput0: true } },
          };
        }
        return { success: true, data: { ok: true } };
      },
    });

    const visited = result.perIteration[0];
    expect(visited).toContain("sequencer");
    expect(visited).toContain("c-master");
    expect(visited).toContain("autoline");
    // *** This is the regression assertion the production logs failed:
    //     after autoline (success), decode must run.
    expect(visited).toContain("decode");
    expect(visited).toContain("c-workable");
    expect(visited).toContain("dssAutoLine");
    expect(visited).toContain("c-line");
    expect(visited).toContain("work");
    expect(visited).not.toContain("discord");
  });

  it("matches the production failure: master=true, workable=false routes Discord branch", async () => {
    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: ["MAKER"],
      runStep: async ({ nodeId, actionType }) => {
        if (actionType === "Condition") {
          if (nodeId === "c-master") {
            return { success: true, data: { condition: true } };
          }
          if (nodeId === "c-workable") {
            return { success: true, data: { condition: false } };
          }
          if (nodeId === "c-line") {
            return { success: true, data: { condition: false } };
          }
        }
        return { success: true, data: { ok: true } };
      },
    });

    const visited = result.perIteration[0];
    expect(visited).toContain("autoline");
    expect(visited).toContain("decode"); // <-- regression node
    expect(visited).toContain("c-workable");
    expect(visited).toContain("discord"); // false branch
    expect(visited).not.toContain("dssAutoLine"); // true branch skipped
  });

  it("stops the chain at c-master=false and never reaches autoline", async () => {
    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: ["GELATO"],
      runStep: async ({ nodeId, actionType }) => {
        if (actionType === "Condition" && nodeId === "c-master") {
          return { success: true, data: { condition: false } };
        }
        return { success: true, data: { ok: true } };
      },
    });

    const visited = result.perIteration[0];
    expect(visited).toContain("sequencer");
    expect(visited).toContain("c-master");
    expect(visited).not.toContain("autoline");
    expect(visited).not.toContain("decode");
  });

  it("runs all 3 parallel iterations independently with separate visit sets", async () => {
    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: ["MAKER", "GELATO", "KEEP3R"],
      runStep: async ({ nodeId, actionType }) => {
        if (actionType === "Condition" && nodeId === "c-master") {
          return { success: true, data: { condition: false } };
        }
        return { success: true, data: { ok: true } };
      },
    });

    expect(result.perIteration).toHaveLength(3);
    for (const iter of result.perIteration) {
      expect(iter).toContain("sequencer");
      expect(iter).toContain("c-master");
      expect(iter).not.toContain("autoline");
    }
  });
});

// ---------------------------------------------------------------------------
// Pure action chain: For Each -> A -> B -> C (no conditions)
// ---------------------------------------------------------------------------

describe("For Each body recursion: pure action chains", () => {
  it("visits A, B, C in order when there are no conditions", async () => {
    const nodes = [
      forEach("for-each"),
      action("a", "web3/read-contract"),
      action("b", "code/run-code"),
      action("c", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "b"),
      edge("b", "c"),
    ];

    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: [1],
      runStep: async () => ({ success: true, data: { ok: true } }),
    });

    expect(result.visitOrder.map((v) => v.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("stops the chain when an action returns success: false", async () => {
    const nodes = [
      forEach("for-each"),
      action("a", "web3/read-contract"),
      action("b", "code/run-code"),
      action("c", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "b"),
      edge("b", "c"),
    ];

    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: [1],
      runStep: async ({ nodeId }) => {
        if (nodeId === "b") {
          return { success: false, error: "boom" };
        }
        return { success: true };
      },
    });

    const visited = result.perIteration[0];
    expect(visited).toContain("a");
    expect(visited).toContain("b");
    expect(visited).not.toContain("c");
  });

  it("fans out when an action has multiple downstream targets", async () => {
    const nodes = [
      forEach("for-each"),
      action("a", "web3/read-contract"),
      action("b1", "code/run-code"),
      action("b2", "code/run-code"),
      action("b3", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "b1"),
      edge("a", "b2"),
      edge("a", "b3"),
    ];

    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: [1],
      runStep: async () => ({ success: true }),
    });

    const visited = result.perIteration[0];
    expect(visited).toContain("b1");
    expect(visited).toContain("b2");
    expect(visited).toContain("b3");
  });
});

// ---------------------------------------------------------------------------
// Long action chain after a condition
// ---------------------------------------------------------------------------

describe("For Each body recursion: long action chain after condition", () => {
  it("traverses 5 actions after a single condition gate", async () => {
    const nodes = [
      forEach("for-each"),
      condition("gate"),
      action("a1", "web3/read-contract"),
      action("a2", "web3/read-contract"),
      action("a3", "code/run-code"),
      action("a4", "web3/read-contract"),
      action("a5", "web3/write-contract"),
    ];
    const edges = [
      edge("for-each", "gate", "loop"),
      edge("gate", "a1", "true"),
      edge("a1", "a2"),
      edge("a2", "a3"),
      edge("a3", "a4"),
      edge("a4", "a5"),
    ];

    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: [1],
      runStep: async ({ actionType }) =>
        actionType === "Condition"
          ? { success: true, data: { condition: true } }
          : { success: true },
    });

    expect(result.visitOrder.map((v) => v.nodeId)).toEqual([
      "gate",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Re-converging branches: A -> B (via two paths)
// ---------------------------------------------------------------------------

describe("For Each body recursion: convergence within an iteration", () => {
  it("runs the convergence target only once even when reached via two paths", async () => {
    const nodes = [
      forEach("for-each"),
      action("a", "web3/read-contract"),
      condition("gate"),
      action("b1", "code/run-code"),
      action("b2", "code/run-code"),
      action("converge", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "gate"),
      edge("gate", "b1", "true"),
      edge("gate", "b2", "false"),
      edge("b1", "converge"),
      edge("b2", "converge"),
    ];

    const result = await simulate({
      nodes,
      edges,
      forEachNodeId: "for-each",
      items: [1],
      runStep: async ({ actionType }) =>
        actionType === "Condition"
          ? { success: true, data: { condition: true } }
          : { success: true },
    });

    const visits = result.visitOrder
      .filter((v) => v.iterationIndex === 0)
      .map((v) => v.nodeId);
    // converge appears exactly once because bodyVisited dedupes within an iteration
    expect(visits.filter((v) => v === "converge")).toHaveLength(1);
  });
});
