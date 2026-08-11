import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { generateWorkflowCode } from "@/lib/workflow/codegen/codegen";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

function createTriggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Manual Trigger",
      type: "trigger",
      config: { triggerType: "manual" },
    },
  };
}

function createConditionNode(id: string, condition: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Check Value",
      type: "action",
      config: { actionType: "Condition", condition },
    },
  };
}

function createActionNode(id: string, label: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 200 },
    data: {
      label,
      type: "action",
      config: { actionType: "Send Webhook" },
    },
  };
}

function createEdge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle,
  };
}

describe("condition codegen with dual output handles", () => {
  it("should generate if/else when true and false handles are connected", () => {
    const nodes: WorkflowNode[] = [
      createTriggerNode("trigger"),
      createConditionNode("cond", "x > 10"),
      createActionNode("on-true", "True Action"),
      createActionNode("on-false", "False Action"),
    ];

    const edges: WorkflowEdge[] = [
      createEdge("trigger", "cond"),
      createEdge("cond", "on-true", "true"),
      createEdge("cond", "on-false", "false"),
    ];

    const result = generateWorkflowCode(nodes, edges);
    expect(result.validationErrors).toBeUndefined();
    expect(result.code).toContain("if (x > 10)");
    expect(result.code).toContain("else");
  });

  it("should generate if-only when only true handle is connected", () => {
    const nodes: WorkflowNode[] = [
      createTriggerNode("trigger"),
      createConditionNode("cond", "status === 200"),
      createActionNode("on-true", "Success Action"),
    ];

    const edges: WorkflowEdge[] = [
      createEdge("trigger", "cond"),
      createEdge("cond", "on-true", "true"),
    ];

    const result = generateWorkflowCode(nodes, edges);
    expect(result.validationErrors).toBeUndefined();
    expect(result.code).toContain("if (status === 200)");
    expect(result.code).not.toContain("else");
  });

  it("should generate else-only when only false handle is connected", () => {
    const nodes: WorkflowNode[] = [
      createTriggerNode("trigger"),
      createConditionNode("cond", "isDisabled === true"),
      createActionNode("on-false", "Fallback Action"),
    ];

    const edges: WorkflowEdge[] = [
      createEdge("trigger", "cond"),
      createEdge("cond", "on-false", "false"),
    ];

    const result = generateWorkflowCode(nodes, edges);
    expect(result.validationErrors).toBeUndefined();
    // The condition runs, and only the false branch has targets
    expect(result.code).toContain("isDisabled === true");
  });

  it("should support multiple targets on the same handle", () => {
    const nodes: WorkflowNode[] = [
      createTriggerNode("trigger"),
      createConditionNode("cond", "ready === true"),
      createActionNode("a1", "Action A"),
      createActionNode("a2", "Action B"),
    ];

    const edges: WorkflowEdge[] = [
      createEdge("trigger", "cond"),
      createEdge("cond", "a1", "true"),
      createEdge("cond", "a2", "true"),
    ];

    const result = generateWorkflowCode(nodes, edges);
    expect(result.validationErrors).toBeUndefined();
    expect(result.code).toContain("if (ready === true)");
  });

  describe("legacy fallback (edges without sourceHandle)", () => {
    it("should fall back to positional routing when edges lack sourceHandle", () => {
      const nodes: WorkflowNode[] = [
        createTriggerNode("trigger"),
        createConditionNode("cond", "a > b"),
        createActionNode("next", "Next Action"),
      ];

      const edges: WorkflowEdge[] = [
        createEdge("trigger", "cond"),
        createEdge("cond", "next"), // no sourceHandle
      ];

      const result = generateWorkflowCode(nodes, edges);
      expect(result.validationErrors).toBeUndefined();
      expect(result.code).toContain("a > b");
    });
  });

  describe("nested conditions with handles", () => {
    it("should handle chained conditions with both handles", () => {
      const nodes: WorkflowNode[] = [
        createTriggerNode("trigger"),
        createConditionNode("cond1", "x > 0"),
        createConditionNode("cond2", "x > 100"),
        createActionNode("low", "Low Action"),
        createActionNode("high", "High Action"),
        createActionNode("negative", "Negative Action"),
      ];

      const edges: WorkflowEdge[] = [
        createEdge("trigger", "cond1"),
        createEdge("cond1", "cond2", "true"),
        createEdge("cond1", "negative", "false"),
        createEdge("cond2", "high", "true"),
        createEdge("cond2", "low", "false"),
      ];

      const result = generateWorkflowCode(nodes, edges);
      expect(result.validationErrors).toBeUndefined();
      expect(result.code).toContain("if (x > 0)");
      expect(result.code).toContain("if (x > 100)");
      expect(result.code).toContain("else");
    });
  });
});
