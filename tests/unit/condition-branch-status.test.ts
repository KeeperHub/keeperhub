import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import {
  type ConditionDecision,
  collectAllSkippedTargets,
  collectSkippedTargets,
} from "@/lib/workflow/nodes/condition/skipped-branch";

type ExecutionResult = {
  success: boolean;
  error?: string;
};

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

/**
 * Simulates the branch-aware finalSuccess calculation from the executor.
 * Mirrors the logic at the end of executeWorkflow.
 */
function computeFinalSuccess(
  results: Record<string, ExecutionResult>,
  conditionDecisions: Map<string, ConditionDecision>
): boolean {
  const allSkippedTargets = collectAllSkippedTargets(conditionDecisions);
  return Object.entries(results).every(
    ([nodeId, r]) => r.success || allSkippedTargets.has(nodeId)
  );
}

describe("condition branch status (finalSuccess)", () => {
  describe("two parallel conditions, one true one false", () => {
    it("should return finalSuccess=true when both condition nodes succeed", () => {
      // Topology: Trigger -> Cond1 (<1 ETH) + Cond2 (>=1 ETH) -> Action1 + Action2
      // Balance is 2 ETH: Cond1=false, Cond2=true
      const edges: EdgeLike[] = [
        createEdge("cond-1", "action-a", "true"),
        createEdge("cond-2", "action-b", "true"),
      ];
      const edgesBySourceHandle = buildEdgesBySourceHandle(edges);

      // Both conditions execute and succeed (condition step returns success even when false)
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "cond-2": { success: true },
        "action-b": { success: true },
      };

      // Cond1 routes to true (empty), skips false (empty). Cond2 routes to true (action-b).
      const decisions = new Map<string, ConditionDecision>([
        [
          "cond-1",
          {
            taken: "false",
            skippedTargets: collectSkippedTargets(
              "cond-1",
              "true",
              edgesBySourceHandle
            ),
          },
        ],
        [
          "cond-2",
          {
            taken: "true",
            skippedTargets: collectSkippedTargets(
              "cond-2",
              "false",
              edgesBySourceHandle
            ),
          },
        ],
      ]);

      expect(computeFinalSuccess(results, decisions)).toBe(true);
    });
  });

  describe("two parallel conditions, both false", () => {
    it("should return finalSuccess=true when conditions succeed even if both are false", () => {
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "cond-2": { success: true },
      };
      const decisions = new Map<string, ConditionDecision>([
        ["cond-1", { taken: "false", skippedTargets: ["action-a"] }],
        ["cond-2", { taken: "false", skippedTargets: ["action-b"] }],
      ]);

      expect(computeFinalSuccess(results, decisions)).toBe(true);
    });
  });

  describe("condition with _evaluationError on skipped branch target", () => {
    it("should return finalSuccess=true when failed node is a skipped target", () => {
      // Scenario: cond-1 routes true, skipping action-dead.
      // action-dead somehow ended up in results with success:false
      // (e.g., it was a condition that tried to reference dead-branch data)
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "action-live": { success: true },
        "action-dead": {
          success: false,
          error:
            'Condition references node "dead-node" but no output was found.',
        },
      };
      const decisions = new Map<string, ConditionDecision>([
        ["cond-1", { taken: "true", skippedTargets: ["action-dead"] }],
      ]);

      expect(computeFinalSuccess(results, decisions)).toBe(true);
    });

    it("should return finalSuccess=false when failed node is NOT on a skipped branch", () => {
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "action-live": {
          success: false,
          error: "Step failed with a real error",
        },
      };
      const decisions = new Map<string, ConditionDecision>([
        ["cond-1", { taken: "true", skippedTargets: ["action-dead"] }],
      ]);

      expect(computeFinalSuccess(results, decisions)).toBe(false);
    });
  });

  describe("nested conditions", () => {
    it("should handle inner condition dead branch inside outer condition true branch", () => {
      // Trigger -> Cond1 -> [true] -> Cond2 -> [true] -> ActionA
      //                                    -> [false] -> ActionB (dead)
      //                 -> [false] -> ActionC (dead)
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "cond-2": { success: true },
        "action-a": { success: true },
      };
      const decisions = new Map<string, ConditionDecision>([
        ["cond-1", { taken: "true", skippedTargets: ["action-c"] }],
        ["cond-2", { taken: "true", skippedTargets: ["action-b"] }],
      ]);

      expect(computeFinalSuccess(results, decisions)).toBe(true);
    });
  });

  describe("mixed condition + regular node failure", () => {
    it("should return finalSuccess=false when a live-branch action fails", () => {
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "action-live": { success: false, error: "HTTP 500 from external API" },
        "action-dead": { success: false, error: "Dead branch reference" },
      };
      const decisions = new Map<string, ConditionDecision>([
        ["cond-1", { taken: "true", skippedTargets: ["action-dead"] }],
      ]);

      // action-dead is excused (skipped), but action-live is a real failure
      expect(computeFinalSuccess(results, decisions)).toBe(false);
    });
  });

  describe("no condition decisions (non-branching workflow)", () => {
    it("should fall back to standard all-success check", () => {
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "action-1": { success: true },
        "action-2": { success: true },
      };
      const decisions = new Map<string, ConditionDecision>();

      expect(computeFinalSuccess(results, decisions)).toBe(true);
    });

    it("should detect failure in non-branching workflow", () => {
      const results: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "action-1": { success: false, error: "timeout" },
      };
      const decisions = new Map<string, ConditionDecision>();

      expect(computeFinalSuccess(results, decisions)).toBe(false);
    });
  });

  describe("cross-branch template reference (dead-branch grace)", () => {
    it("should evaluate to false gracefully when referencing a dead-branch node", () => {
      // node "action-dead" exists in the graph but was never executed
      const nodeMap = new Map<string, unknown>([
        ["trigger", {}],
        ["cond-1", {}],
        ["action-live", {}],
        ["action-dead", {}],
      ]);
      const executionResults: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "cond-1": { success: true },
        "action-live": { success: true },
      };
      const outputs = {
        action_live: { label: "Live Action", data: { value: 42 } },
      };

      // Condition references action-dead which was never executed
      const { result } = evaluateConditionExpression(
        "{{@action-dead:Dead Action.value}} >= 1",
        outputs,
        nodeMap,
        executionResults
      );

      // undefined >= 1 evaluates to false
      expect(result).toBe(false);
    });

    it("should still throw when referencing a node not in the graph at all", () => {
      const nodeMap = new Map<string, unknown>([["trigger", {}]]);
      const executionResults: Record<string, ExecutionResult> = {
        trigger: { success: true },
      };

      expect(() =>
        evaluateConditionExpression(
          "{{@nonexistent:Label.field}} >= 1",
          {},
          nodeMap,
          executionResults
        )
      ).toThrow("Condition references node");
    });

    it("should still throw when referencing a node that executed but has no output", () => {
      // Node executed (is in results) but has no output entry
      const nodeMap = new Map<string, unknown>([
        ["trigger", {}],
        ["node-1", {}],
      ]);
      const executionResults: Record<string, ExecutionResult> = {
        trigger: { success: true },
        "node-1": { success: true },
      };

      expect(() =>
        evaluateConditionExpression(
          "{{@node-1:Label.field}} >= 1",
          {},
          nodeMap,
          executionResults
        )
      ).toThrow("Condition references node");
    });
  });
});
