import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";

type EdgeLike = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

/**
 * Helper that mirrors the executor routing logic (lines ~1879-1899):
 * Given a condition result and edge map, return the target node IDs
 * that would execute for a specific source node.
 */
function getRoutedTargets(
  conditionResult: boolean,
  edgesBySourceHandle: ReturnType<typeof buildEdgesBySourceHandle>,
  nodeId: string,
  edgesBySource?: Map<string, string[]>
): string[] {
  const handleMap = edgesBySourceHandle.get(nodeId);
  if (handleMap) {
    const handleId = conditionResult === true ? "true" : "false";
    return handleMap.get(handleId) ?? [];
  }
  // Legacy fallback: no sourceHandle edges, only execute if true
  if (conditionResult === true) {
    return edgesBySource?.get(nodeId) ?? [];
  }
  return [];
}

function createEdge(
  source: string,
  target: string,
  sourceHandle?: string
): EdgeLike {
  return { source, target, sourceHandle };
}

/**
 * Topology used by "complex nested routing" tests:
 *
 *                      cond-root
 *                     /         \
 *              [true]             [false]
 *           /  |  |  |  \       /  |  |  |  \
 *        t1  t2  t3  t4  t5   f1  f2  f3  f4  f5
 *                |                     |
 *             cond-t3              cond-f3
 *            /       \            /       \
 *       [true]     [false]   [true]     [false]
 *       /  |  \      |      /  |  \      |
 *   t3a t3b t3c   t3-fb  f3a f3b f3c  f3-fb
 */
function buildFullTopology(): EdgeLike[] {
  return [
    createEdge("cond-root", "t1", "true"),
    createEdge("cond-root", "t2", "true"),
    createEdge("cond-root", "t3", "true"),
    createEdge("cond-root", "t4", "true"),
    createEdge("cond-root", "t5", "true"),
    createEdge("cond-root", "f1", "false"),
    createEdge("cond-root", "f2", "false"),
    createEdge("cond-root", "f3", "false"),
    createEdge("cond-root", "f4", "false"),
    createEdge("cond-root", "f5", "false"),
    createEdge("cond-t3", "t3a", "true"),
    createEdge("cond-t3", "t3b", "true"),
    createEdge("cond-t3", "t3c", "true"),
    createEdge("cond-t3", "t3-fb", "false"),
    createEdge("cond-f3", "f3a", "true"),
    createEdge("cond-f3", "f3b", "true"),
    createEdge("cond-f3", "f3c", "true"),
    createEdge("cond-f3", "f3-fb", "false"),
  ];
}

describe("condition branch routing", () => {
  describe("true branch executes, false branch does not", () => {
    it("should route to true-handle targets when condition is true", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "action-a", "true"),
        createEdge("cond-1", "action-b", "true"),
        createEdge("cond-1", "action-c", "false"),
        createEdge("cond-1", "action-d", "false"),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(true, edgeMap, "cond-1");

      expect(targets).toEqual(["action-a", "action-b"]);
      expect(targets).not.toContain("action-c");
      expect(targets).not.toContain("action-d");
    });

    it("should evaluate expression to true and select true-handle targets", () => {
      const outputs = {
        node1: { label: "Balance", data: { value: 200 } },
      };
      const { result } = evaluateConditionExpression(
        "{{@node1:Balance.value}} > 100",
        outputs
      );
      expect(result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "notify", "true"),
        createEdge("cond-1", "skip", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["notify"]);
    });
  });

  describe("false branch executes, true branch does not", () => {
    it("should route to false-handle targets when condition is false", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "action-a", "true"),
        createEdge("cond-1", "action-b", "true"),
        createEdge("cond-1", "action-c", "false"),
        createEdge("cond-1", "action-d", "false"),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(false, edgeMap, "cond-1");

      expect(targets).toEqual(["action-c", "action-d"]);
      expect(targets).not.toContain("action-a");
      expect(targets).not.toContain("action-b");
    });

    it("should evaluate expression to false and select false-handle targets", () => {
      const outputs = {
        node1: { label: "Balance", data: { value: 50 } },
      };
      const { result } = evaluateConditionExpression(
        "{{@node1:Balance.value}} > 100",
        outputs
      );
      expect(result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "alert", "true"),
        createEdge("cond-1", "log-low", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["log-low"]);
    });
  });

  describe("multiple nodes on true branch all execute", () => {
    it("should return all 3+ targets on the true handle", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "step-1", "true"),
        createEdge("cond-1", "step-2", "true"),
        createEdge("cond-1", "step-3", "true"),
        createEdge("cond-1", "fallback", "false"),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(true, edgeMap, "cond-1");

      expect(targets).toHaveLength(3);
      expect(targets).toEqual(["step-1", "step-2", "step-3"]);
    });
  });

  describe("multiple nodes on false branch all execute", () => {
    it("should return all 3+ targets on the false handle", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "main-action", "true"),
        createEdge("cond-1", "err-log", "false"),
        createEdge("cond-1", "err-notify", "false"),
        createEdge("cond-1", "err-cleanup", "false"),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(false, edgeMap, "cond-1");

      expect(targets).toHaveLength(3);
      expect(targets).toEqual(["err-log", "err-notify", "err-cleanup"]);
    });
  });

  describe("empty branch (no nodes on chosen handle)", () => {
    it("should return empty array when true handle has no edges", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "fallback-action", "false"),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(true, edgeMap, "cond-1");

      expect(targets).toEqual([]);
    });

    it("should return empty array when false handle has no edges", () => {
      const edges: EdgeLike[] = [createEdge("cond-1", "main-action", "true")];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(false, edgeMap, "cond-1");

      expect(targets).toEqual([]);
    });

    it("should not crash when condition node has no handle edges at all", () => {
      const edges: EdgeLike[] = [];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(true, edgeMap, "cond-1");

      expect(targets).toEqual([]);
    });
  });

  describe("legacy fallback (no handle map)", () => {
    it("should use edgesBySource fallback when edges lack sourceHandle", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "next-action", undefined),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      // No handle map for cond-1 since sourceHandle is undefined
      expect(edgeMap.has("cond-1")).toBe(false);

      const legacyEdgesBySource = new Map<string, string[]>();
      legacyEdgesBySource.set("cond-1", ["next-action"]);

      // Legacy: true -> execute downstream
      const trueTargets = getRoutedTargets(
        true,
        edgeMap,
        "cond-1",
        legacyEdgesBySource
      );
      expect(trueTargets).toEqual(["next-action"]);

      // Legacy: false -> do not execute downstream
      const falseTargets = getRoutedTargets(
        false,
        edgeMap,
        "cond-1",
        legacyEdgesBySource
      );
      expect(falseTargets).toEqual([]);
    });

    it("should skip edges with null sourceHandle", () => {
      const edges: EdgeLike[] = [
        { source: "cond-1", target: "action-1", sourceHandle: null },
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      expect(edgeMap.has("cond-1")).toBe(false);
    });

    it("should skip edges with empty string sourceHandle", () => {
      const edges: EdgeLike[] = [
        { source: "cond-1", target: "action-1", sourceHandle: "" },
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      expect(edgeMap.has("cond-1")).toBe(false);
    });
  });

  describe("condition with BigInt values routes correctly", () => {
    it("should route to true branch when BigInt comparison is true", () => {
      const outputs = {
        node1: {
          label: "Balance",
          data: { wei: "2000000000000000000" },
        },
      };
      const { result } = evaluateConditionExpression(
        "{{@node1:Balance.wei}} > 1000000000000000000",
        outputs
      );
      expect(result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "swap", "true"),
        createEdge("cond-1", "wait", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["swap"]);
    });

    it("should route to false branch when BigInt comparison is false", () => {
      const outputs = {
        node1: {
          label: "Balance",
          data: { wei: "500000000000000000" },
        },
      };
      const { result } = evaluateConditionExpression(
        "{{@node1:Balance.wei}} > 1000000000000000000",
        outputs
      );
      expect(result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "swap", "true"),
        createEdge("cond-1", "wait", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["wait"]);
    });
  });

  describe("mixed handle and non-handle edges", () => {
    it("should only include edges with sourceHandle in the handle map", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "action-true", "true"),
        createEdge("cond-1", "action-false", "false"),
        createEdge("cond-1", "action-legacy", undefined),
        { source: "cond-1", target: "action-null", sourceHandle: null },
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);
      const handleMap = edgeMap.get("cond-1");

      expect(handleMap).toBeDefined();
      expect(handleMap?.get("true")).toEqual(["action-true"]);
      expect(handleMap?.get("false")).toEqual(["action-false"]);

      // The handle map exists, so legacy edges are ignored during routing
      const trueTargets = getRoutedTargets(true, edgeMap, "cond-1");
      expect(trueTargets).toEqual(["action-true"]);
      expect(trueTargets).not.toContain("action-legacy");
      expect(trueTargets).not.toContain("action-null");
    });

    it("should separate edges from different source nodes", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-1", "c1-true", "true"),
        createEdge("cond-1", "c1-false", "false"),
        createEdge("cond-2", "c2-true", "true"),
        createEdge("cond-2", "c2-false", "false"),
        createEdge("action-1", "action-2", undefined),
      ];

      const edgeMap = buildEdgesBySourceHandle(edges);

      expect(edgeMap.get("cond-1")?.get("true")).toEqual(["c1-true"]);
      expect(edgeMap.get("cond-1")?.get("false")).toEqual(["c1-false"]);
      expect(edgeMap.get("cond-2")?.get("true")).toEqual(["c2-true"]);
      expect(edgeMap.get("cond-2")?.get("false")).toEqual(["c2-false"]);
      expect(edgeMap.has("action-1")).toBe(false);
    });
  });

  describe("condition from visual builder (conditionConfig) routes correctly", () => {
    it("should resolve visual config to expression and route on true", () => {
      const config: Record<string, unknown> = {
        actionType: "Condition",
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:Balance.value}}",
                operator: ">",
                rightOperand: "100",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      if (expression === undefined) {
        throw new Error("Expected expression to be defined");
      }

      const outputs = {
        node1: { label: "Balance", data: { value: 200 } },
      };
      const { result } = evaluateConditionExpression(expression, outputs);
      expect(result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "proceed", "true"),
        createEdge("cond-1", "skip", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["proceed"]);
    });

    it("should resolve visual config to expression and route on false", () => {
      const config: Record<string, unknown> = {
        actionType: "Condition",
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:Balance.value}}",
                operator: ">",
                rightOperand: "100",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      if (expression === undefined) {
        throw new Error("Expected expression to be defined");
      }

      const outputs = {
        node1: { label: "Balance", data: { value: 50 } },
      };
      const { result } = evaluateConditionExpression(expression, outputs);
      expect(result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "proceed", "true"),
        createEdge("cond-1", "skip", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["skip"]);
    });

    it("should prefer conditionConfig over raw condition string", () => {
      const config: Record<string, unknown> = {
        actionType: "Condition",
        condition: "false",
        conditionConfig: {
          group: {
            id: "g1",
            logic: "AND",
            rules: [
              {
                id: "r1",
                leftOperand: "{{@node1:Source.active}}",
                operator: "===",
                rightOperand: "true",
              },
            ],
          },
        },
      };

      const expression = resolveConditionExpression(config);
      if (expression === undefined) {
        throw new Error("Expected expression to be defined");
      }
      // Should NOT be "false" from the stale condition string
      expect(expression).not.toBe("false");

      const outputs = {
        node1: { label: "Source", data: { active: true } },
      };
      const { result } = evaluateConditionExpression(expression, outputs);
      expect(result).toBe(true);
    });
  });

  describe("complex nested routing: condition -> many nodes -> nested conditions", () => {
    it("root=true routes to all 5 true-branch nodes, none from false branch", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());
      const targets = getRoutedTargets(true, edgeMap, "cond-root");

      expect(targets).toHaveLength(5);
      expect(targets).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    });

    it("root=false routes to all 5 false-branch nodes, none from true branch", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());
      const targets = getRoutedTargets(false, edgeMap, "cond-root");

      expect(targets).toHaveLength(5);
      expect(targets).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    });

    it("root=true then nested cond-t3=true routes to t3a,t3b,t3c", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      // Step 1: root evaluates true
      const rootTargets = getRoutedTargets(true, edgeMap, "cond-root");
      expect(rootTargets).toContain("t3");

      // Step 2: cond-t3 (downstream of t3) evaluates true
      const nestedTargets = getRoutedTargets(true, edgeMap, "cond-t3");
      expect(nestedTargets).toHaveLength(3);
      expect(nestedTargets).toEqual(["t3a", "t3b", "t3c"]);
    });

    it("root=true then nested cond-t3=false routes to t3-fb only", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      const rootTargets = getRoutedTargets(true, edgeMap, "cond-root");
      expect(rootTargets).toContain("t3");

      const nestedTargets = getRoutedTargets(false, edgeMap, "cond-t3");
      expect(nestedTargets).toEqual(["t3-fb"]);
    });

    it("root=false then nested cond-f3=true routes to f3a,f3b,f3c", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      const rootTargets = getRoutedTargets(false, edgeMap, "cond-root");
      expect(rootTargets).toContain("f3");

      const nestedTargets = getRoutedTargets(true, edgeMap, "cond-f3");
      expect(nestedTargets).toHaveLength(3);
      expect(nestedTargets).toEqual(["f3a", "f3b", "f3c"]);
    });

    it("root=false then nested cond-f3=false routes to f3-fb only", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      const rootTargets = getRoutedTargets(false, edgeMap, "cond-root");
      expect(rootTargets).toContain("f3");

      const nestedTargets = getRoutedTargets(false, edgeMap, "cond-f3");
      expect(nestedTargets).toEqual(["f3-fb"]);
    });

    it("nested conditions are fully independent - cond-t3 routing does not affect cond-f3", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      // Both nested conditions route independently
      const t3True = getRoutedTargets(true, edgeMap, "cond-t3");
      const f3False = getRoutedTargets(false, edgeMap, "cond-f3");

      expect(t3True).toEqual(["t3a", "t3b", "t3c"]);
      expect(f3False).toEqual(["f3-fb"]);

      // Reversing doesn't contaminate
      const t3False = getRoutedTargets(false, edgeMap, "cond-t3");
      const f3True = getRoutedTargets(true, edgeMap, "cond-f3");

      expect(t3False).toEqual(["t3-fb"]);
      expect(f3True).toEqual(["f3a", "f3b", "f3c"]);
    });

    it("root=true does NOT make cond-f3 targets reachable", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      const rootTargets = getRoutedTargets(true, edgeMap, "cond-root");

      // f3 is NOT in the true branch
      expect(rootTargets).not.toContain("f3");
      // Even if we query cond-f3, the root gate already blocked it
      // The targets exist in the map but the executor would never reach them
      // because f3 was never executed
    });

    it("full walk: root=true, cond-t3=true collects correct total set", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      // Simulate executor walk
      const level1 = getRoutedTargets(true, edgeMap, "cond-root");
      expect(level1).toEqual(["t1", "t2", "t3", "t4", "t5"]);

      // t3 is a condition node, so it evaluates and routes further
      const level2 = getRoutedTargets(true, edgeMap, "cond-t3");
      expect(level2).toEqual(["t3a", "t3b", "t3c"]);

      // Collect all nodes that would execute
      const allExecuted = new Set([...level1, ...level2]);
      expect(allExecuted).toEqual(
        new Set(["t1", "t2", "t3", "t4", "t5", "t3a", "t3b", "t3c"])
      );

      // None of the false-branch nodes executed
      const falseBranchNodes = [
        "f1",
        "f2",
        "f3",
        "f4",
        "f5",
        "t3-fb",
        "f3a",
        "f3b",
        "f3c",
        "f3-fb",
      ];
      for (const node of falseBranchNodes) {
        expect(allExecuted.has(node)).toBe(false);
      }
    });

    it("full walk: root=false, cond-f3=false collects correct total set", () => {
      const edgeMap = buildEdgesBySourceHandle(buildFullTopology());

      const level1 = getRoutedTargets(false, edgeMap, "cond-root");
      expect(level1).toEqual(["f1", "f2", "f3", "f4", "f5"]);

      const level2 = getRoutedTargets(false, edgeMap, "cond-f3");
      expect(level2).toEqual(["f3-fb"]);

      const allExecuted = new Set([...level1, ...level2]);
      expect(allExecuted).toEqual(
        new Set(["f1", "f2", "f3", "f4", "f5", "f3-fb"])
      );

      // None of the true-branch nodes executed
      const trueBranchNodes = [
        "t1",
        "t2",
        "t3",
        "t4",
        "t5",
        "t3a",
        "t3b",
        "t3c",
        "t3-fb",
        "f3a",
        "f3b",
        "f3c",
      ];
      for (const node of trueBranchNodes) {
        expect(allExecuted.has(node)).toBe(false);
      }
    });

    it("end-to-end with evaluated expressions at each level", () => {
      const outputs = {
        balance: { label: "Balance", data: { eth: 5 } },
        price: { label: "Price", data: { usd: 3000 } },
        gas: { label: "Gas", data: { gwei: 15 } },
      };

      // Root condition: balance > 1 ETH
      const root = evaluateConditionExpression(
        "{{@balance:Balance.eth}} > 1",
        outputs
      );
      expect(root.result).toBe(true);

      // Nested condition on true branch: price > 2000
      const nested = evaluateConditionExpression(
        "{{@price:Price.usd}} > 2000",
        outputs
      );
      expect(nested.result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("cond-root", "swap-a", "true"),
        createEdge("cond-root", "swap-b", "true"),
        createEdge("cond-root", "swap-c", "true"),
        createEdge("cond-root", "cond-price", "true"),
        createEdge("cond-root", "swap-d", "true"),
        createEdge("cond-root", "swap-e", "true"),
        createEdge("cond-root", "wait-1", "false"),
        createEdge("cond-root", "wait-2", "false"),
        createEdge("cond-root", "wait-3", "false"),
        createEdge("cond-root", "wait-4", "false"),
        createEdge("cond-root", "wait-5", "false"),
        createEdge("cond-root", "wait-6", "false"),
        createEdge("cond-price", "exec-limit", "true"),
        createEdge("cond-price", "exec-market", "true"),
        createEdge("cond-price", "exec-stop", "true"),
        createEdge("cond-price", "hold", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      // Root routes true
      const level1 = getRoutedTargets(root.result, edgeMap, "cond-root");
      expect(level1).toHaveLength(6);
      expect(level1).toEqual([
        "swap-a",
        "swap-b",
        "swap-c",
        "cond-price",
        "swap-d",
        "swap-e",
      ]);

      // Nested price condition routes true
      const level2 = getRoutedTargets(nested.result, edgeMap, "cond-price");
      expect(level2).toEqual(["exec-limit", "exec-market", "exec-stop"]);

      // Total executed
      const allExecuted = new Set([...level1, ...level2]);
      expect(allExecuted.size).toBe(9);
      expect(allExecuted.has("hold")).toBe(false);
      expect(allExecuted.has("wait-1")).toBe(false);
    });

    it("end-to-end: root=true, nested=false flips only the inner branch", () => {
      const outputs = {
        balance: { label: "Balance", data: { eth: 5 } },
        price: { label: "Price", data: { usd: 1500 } },
      };

      const root = evaluateConditionExpression(
        "{{@balance:Balance.eth}} > 1",
        outputs
      );
      expect(root.result).toBe(true);

      const nested = evaluateConditionExpression(
        "{{@price:Price.usd}} > 2000",
        outputs
      );
      expect(nested.result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("cond-root", "action-1", "true"),
        createEdge("cond-root", "action-2", "true"),
        createEdge("cond-root", "action-3", "true"),
        createEdge("cond-root", "action-4", "true"),
        createEdge("cond-root", "action-5", "true"),
        createEdge("cond-root", "cond-nested", "true"),
        createEdge("cond-root", "skip-1", "false"),
        createEdge("cond-root", "skip-2", "false"),
        createEdge("cond-root", "skip-3", "false"),
        createEdge("cond-root", "skip-4", "false"),
        createEdge("cond-root", "skip-5", "false"),
        createEdge("cond-nested", "premium-a", "true"),
        createEdge("cond-nested", "premium-b", "true"),
        createEdge("cond-nested", "premium-c", "true"),
        createEdge("cond-nested", "premium-d", "true"),
        createEdge("cond-nested", "premium-e", "true"),
        createEdge("cond-nested", "budget-a", "false"),
        createEdge("cond-nested", "budget-b", "false"),
        createEdge("cond-nested", "budget-c", "false"),
        createEdge("cond-nested", "budget-d", "false"),
        createEdge("cond-nested", "budget-e", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      const level1 = getRoutedTargets(root.result, edgeMap, "cond-root");
      expect(level1).toHaveLength(6);
      expect(level1).toContain("cond-nested");

      // Nested condition is false -> budget branch
      const level2 = getRoutedTargets(nested.result, edgeMap, "cond-nested");
      expect(level2).toHaveLength(5);
      expect(level2).toEqual([
        "budget-a",
        "budget-b",
        "budget-c",
        "budget-d",
        "budget-e",
      ]);

      const allExecuted = new Set([...level1, ...level2]);
      // Premium nodes should NOT have executed
      for (const node of [
        "premium-a",
        "premium-b",
        "premium-c",
        "premium-d",
        "premium-e",
      ]) {
        expect(allExecuted.has(node)).toBe(false);
      }
      // Root false branch should NOT have executed
      for (const node of ["skip-1", "skip-2", "skip-3", "skip-4", "skip-5"]) {
        expect(allExecuted.has(node)).toBe(false);
      }
      // Budget nodes should have executed
      for (const node of [
        "budget-a",
        "budget-b",
        "budget-c",
        "budget-d",
        "budget-e",
      ]) {
        expect(allExecuted.has(node)).toBe(true);
      }
    });

    it("three-level deep: root -> nested -> deeply nested", () => {
      const edges: EdgeLike[] = [
        // Root: 5 true, 5 false
        createEdge("cond-root", "r-t1", "true"),
        createEdge("cond-root", "r-t2", "true"),
        createEdge("cond-root", "r-t3", "true"),
        createEdge("cond-root", "r-t4", "true"),
        createEdge("cond-root", "cond-mid", "true"),
        createEdge("cond-root", "r-f1", "false"),
        createEdge("cond-root", "r-f2", "false"),
        createEdge("cond-root", "r-f3", "false"),
        createEdge("cond-root", "r-f4", "false"),
        createEdge("cond-root", "r-f5", "false"),
        // Mid-level: 5 true, 5 false
        createEdge("cond-mid", "m-t1", "true"),
        createEdge("cond-mid", "m-t2", "true"),
        createEdge("cond-mid", "m-t3", "true"),
        createEdge("cond-mid", "m-t4", "true"),
        createEdge("cond-mid", "cond-deep", "true"),
        createEdge("cond-mid", "m-f1", "false"),
        createEdge("cond-mid", "m-f2", "false"),
        createEdge("cond-mid", "m-f3", "false"),
        createEdge("cond-mid", "m-f4", "false"),
        createEdge("cond-mid", "m-f5", "false"),
        // Deep level: 5 true, 5 false
        createEdge("cond-deep", "d-t1", "true"),
        createEdge("cond-deep", "d-t2", "true"),
        createEdge("cond-deep", "d-t3", "true"),
        createEdge("cond-deep", "d-t4", "true"),
        createEdge("cond-deep", "d-t5", "true"),
        createEdge("cond-deep", "d-f1", "false"),
        createEdge("cond-deep", "d-f2", "false"),
        createEdge("cond-deep", "d-f3", "false"),
        createEdge("cond-deep", "d-f4", "false"),
        createEdge("cond-deep", "d-f5", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      // Scenario: root=true, mid=true, deep=false
      const l1 = getRoutedTargets(true, edgeMap, "cond-root");
      expect(l1).toEqual(["r-t1", "r-t2", "r-t3", "r-t4", "cond-mid"]);

      const l2 = getRoutedTargets(true, edgeMap, "cond-mid");
      expect(l2).toEqual(["m-t1", "m-t2", "m-t3", "m-t4", "cond-deep"]);

      const l3 = getRoutedTargets(false, edgeMap, "cond-deep");
      expect(l3).toEqual(["d-f1", "d-f2", "d-f3", "d-f4", "d-f5"]);

      const allExecuted = new Set([...l1, ...l2, ...l3]);

      // Should include: 4 root-true + cond-mid + 4 mid-true + cond-deep + 5 deep-false = 15
      expect(allExecuted.size).toBe(15);

      // Root false branch never reached
      for (const n of ["r-f1", "r-f2", "r-f3", "r-f4", "r-f5"]) {
        expect(allExecuted.has(n)).toBe(false);
      }
      // Mid false branch never reached
      for (const n of ["m-f1", "m-f2", "m-f3", "m-f4", "m-f5"]) {
        expect(allExecuted.has(n)).toBe(false);
      }
      // Deep TRUE branch never reached (we went false)
      for (const n of ["d-t1", "d-t2", "d-t3", "d-t4", "d-t5"]) {
        expect(allExecuted.has(n)).toBe(false);
      }
    });

    it("three-level deep: all false at every level", () => {
      const edges: EdgeLike[] = [
        createEdge("cond-root", "r-t1", "true"),
        createEdge("cond-root", "r-t2", "true"),
        createEdge("cond-root", "r-t3", "true"),
        createEdge("cond-root", "r-t4", "true"),
        createEdge("cond-root", "r-t5", "true"),
        createEdge("cond-root", "r-f1", "false"),
        createEdge("cond-root", "r-f2", "false"),
        createEdge("cond-root", "r-f3", "false"),
        createEdge("cond-root", "r-f4", "false"),
        createEdge("cond-root", "cond-mid", "false"),
        createEdge("cond-mid", "m-t1", "true"),
        createEdge("cond-mid", "m-t2", "true"),
        createEdge("cond-mid", "m-t3", "true"),
        createEdge("cond-mid", "m-t4", "true"),
        createEdge("cond-mid", "m-t5", "true"),
        createEdge("cond-mid", "m-f1", "false"),
        createEdge("cond-mid", "m-f2", "false"),
        createEdge("cond-mid", "m-f3", "false"),
        createEdge("cond-mid", "m-f4", "false"),
        createEdge("cond-mid", "cond-deep", "false"),
        createEdge("cond-deep", "d-t1", "true"),
        createEdge("cond-deep", "d-t2", "true"),
        createEdge("cond-deep", "d-t3", "true"),
        createEdge("cond-deep", "d-t4", "true"),
        createEdge("cond-deep", "d-t5", "true"),
        createEdge("cond-deep", "d-f1", "false"),
        createEdge("cond-deep", "d-f2", "false"),
        createEdge("cond-deep", "d-f3", "false"),
        createEdge("cond-deep", "d-f4", "false"),
        createEdge("cond-deep", "d-f5", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      // All three conditions evaluate false
      const l1 = getRoutedTargets(false, edgeMap, "cond-root");
      expect(l1).toEqual(["r-f1", "r-f2", "r-f3", "r-f4", "cond-mid"]);

      const l2 = getRoutedTargets(false, edgeMap, "cond-mid");
      expect(l2).toEqual(["m-f1", "m-f2", "m-f3", "m-f4", "cond-deep"]);

      const l3 = getRoutedTargets(false, edgeMap, "cond-deep");
      expect(l3).toEqual(["d-f1", "d-f2", "d-f3", "d-f4", "d-f5"]);

      const allExecuted = new Set([...l1, ...l2, ...l3]);
      expect(allExecuted.size).toBe(15);

      // No true branch node at any level should have executed
      const allTrueNodes = [
        "r-t1",
        "r-t2",
        "r-t3",
        "r-t4",
        "r-t5",
        "m-t1",
        "m-t2",
        "m-t3",
        "m-t4",
        "m-t5",
        "d-t1",
        "d-t2",
        "d-t3",
        "d-t4",
        "d-t5",
      ];
      for (const n of allTrueNodes) {
        expect(allExecuted.has(n)).toBe(false);
      }
    });

    it("parallel nested conditions on both branches of root", () => {
      const edges: EdgeLike[] = [
        // Root branches
        createEdge("cond-root", "t-action-1", "true"),
        createEdge("cond-root", "t-action-2", "true"),
        createEdge("cond-root", "t-action-3", "true"),
        createEdge("cond-root", "t-action-4", "true"),
        createEdge("cond-root", "t-action-5", "true"),
        createEdge("cond-root", "cond-true-branch", "true"),
        createEdge("cond-root", "f-action-1", "false"),
        createEdge("cond-root", "f-action-2", "false"),
        createEdge("cond-root", "f-action-3", "false"),
        createEdge("cond-root", "f-action-4", "false"),
        createEdge("cond-root", "f-action-5", "false"),
        createEdge("cond-root", "cond-false-branch", "false"),
        // Nested condition on true branch
        createEdge("cond-true-branch", "tt-1", "true"),
        createEdge("cond-true-branch", "tt-2", "true"),
        createEdge("cond-true-branch", "tt-3", "true"),
        createEdge("cond-true-branch", "tt-4", "true"),
        createEdge("cond-true-branch", "tt-5", "true"),
        createEdge("cond-true-branch", "tf-1", "false"),
        createEdge("cond-true-branch", "tf-2", "false"),
        createEdge("cond-true-branch", "tf-3", "false"),
        createEdge("cond-true-branch", "tf-4", "false"),
        createEdge("cond-true-branch", "tf-5", "false"),
        // Nested condition on false branch
        createEdge("cond-false-branch", "ft-1", "true"),
        createEdge("cond-false-branch", "ft-2", "true"),
        createEdge("cond-false-branch", "ft-3", "true"),
        createEdge("cond-false-branch", "ft-4", "true"),
        createEdge("cond-false-branch", "ft-5", "true"),
        createEdge("cond-false-branch", "ff-1", "false"),
        createEdge("cond-false-branch", "ff-2", "false"),
        createEdge("cond-false-branch", "ff-3", "false"),
        createEdge("cond-false-branch", "ff-4", "false"),
        createEdge("cond-false-branch", "ff-5", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      // Scenario: root=true, true-branch-cond=false
      // Only the true side of root executes, then the nested cond goes false
      const l1 = getRoutedTargets(true, edgeMap, "cond-root");
      expect(l1).toHaveLength(6);
      expect(l1).toContain("cond-true-branch");

      const l2 = getRoutedTargets(false, edgeMap, "cond-true-branch");
      expect(l2).toHaveLength(5);
      expect(l2).toEqual(["tf-1", "tf-2", "tf-3", "tf-4", "tf-5"]);

      const allExecuted = new Set([...l1, ...l2]);
      expect(allExecuted.size).toBe(11);

      // cond-false-branch never reached (root went true)
      // So ft-* and ff-* are all unreachable
      for (const n of [
        "f-action-1",
        "f-action-2",
        "f-action-3",
        "f-action-4",
        "f-action-5",
        "cond-false-branch",
        "ft-1",
        "ft-2",
        "ft-3",
        "ft-4",
        "ft-5",
        "ff-1",
        "ff-2",
        "ff-3",
        "ff-4",
        "ff-5",
      ]) {
        expect(allExecuted.has(n)).toBe(false);
      }
      // tt-* also not reached (nested cond went false)
      for (const n of ["tt-1", "tt-2", "tt-3", "tt-4", "tt-5"]) {
        expect(allExecuted.has(n)).toBe(false);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle boolean expression routing (true literal)", () => {
      const { result } = evaluateConditionExpression(true, {});
      expect(result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "always", "true"),
        createEdge("cond-1", "never", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["always"]);
    });

    it("should handle boolean expression routing (false literal)", () => {
      const { result } = evaluateConditionExpression(false, {});
      expect(result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "always", "true"),
        createEdge("cond-1", "never", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);
      const targets = getRoutedTargets(result, edgeMap, "cond-1");

      expect(targets).toEqual(["never"]);
    });

    it("should handle string expression that evaluates to true", () => {
      const { result } = evaluateConditionExpression("1 === 1", {});
      expect(result).toBe(true);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "yes", "true"),
        createEdge("cond-1", "no", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      expect(getRoutedTargets(result, edgeMap, "cond-1")).toEqual(["yes"]);
    });

    it("should handle string expression that evaluates to false", () => {
      const { result } = evaluateConditionExpression("1 === 2", {});
      expect(result).toBe(false);

      const edges: EdgeLike[] = [
        createEdge("cond-1", "yes", "true"),
        createEdge("cond-1", "no", "false"),
      ];
      const edgeMap = buildEdgesBySourceHandle(edges);

      expect(getRoutedTargets(result, edgeMap, "cond-1")).toEqual(["no"]);
    });
  });
});
