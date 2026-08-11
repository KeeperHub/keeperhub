import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { identifyLoopBody } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MinimalEdge = {
  source: string;
  target: string;
  sourceHandle?: string;
};

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

function edgesToSourceMap(edges: MinimalEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = map.get(edge.source) ?? [];
    targets.push(edge.target);
    map.set(edge.source, targets);
  }
  return map;
}

// ---------------------------------------------------------------------------
// buildEdgesBySourceHandle
// ---------------------------------------------------------------------------

describe("buildEdgesBySourceHandle", () => {
  it("should build a handle map from edges with sourceHandle", () => {
    const edges: MinimalEdge[] = [
      { source: "cond", target: "a", sourceHandle: "true" },
      { source: "cond", target: "b", sourceHandle: "false" },
      { source: "cond", target: "c", sourceHandle: "true" },
    ];

    const result = buildEdgesBySourceHandle(edges);
    const condHandles = result.get("cond");
    expect(condHandles).toBeDefined();
    expect(condHandles?.get("true")).toEqual(["a", "c"]);
    expect(condHandles?.get("false")).toEqual(["b"]);
  });

  it("should ignore edges without sourceHandle", () => {
    const edges: MinimalEdge[] = [
      { source: "a", target: "b" },
      { source: "a", target: "c", sourceHandle: undefined },
    ];

    const result = buildEdgesBySourceHandle(edges);
    expect(result.size).toBe(0);
  });

  it("should handle empty edge list", () => {
    const result = buildEdgesBySourceHandle([]);
    expect(result.size).toBe(0);
  });

  it("should handle multiple source nodes", () => {
    const edges: MinimalEdge[] = [
      { source: "c1", target: "a", sourceHandle: "true" },
      { source: "c2", target: "b", sourceHandle: "false" },
    ];

    const result = buildEdgesBySourceHandle(edges);
    expect(result.get("c1")?.get("true")).toEqual(["a"]);
    expect(result.get("c2")?.get("false")).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// identifyLoopBody — handle-aware edge filtering
// ---------------------------------------------------------------------------

describe("identifyLoopBody with handle-aware edges", () => {
  it("should include condition handle edges within the loop body", () => {
    // For Each -> Condition -> (true: action-a, false: action-b) -> Collect
    const nodes = new Map<string, WorkflowNode>([
      ["foreach", makeNode("foreach", "For Each")],
      ["cond", makeNode("cond", "Condition")],
      ["action-a", makeNode("action-a", "Send Webhook")],
      ["action-b", makeNode("action-b", "Send Webhook")],
      ["collect", makeNode("collect", "Collect")],
    ]);

    const edges: MinimalEdge[] = [
      { source: "foreach", target: "cond" },
      { source: "cond", target: "action-a", sourceHandle: "true" },
      { source: "cond", target: "action-b", sourceHandle: "false" },
      { source: "action-a", target: "collect" },
      { source: "action-b", target: "collect" },
    ];

    const edgesBySource = edgesToSourceMap(edges);
    const handleMap = buildEdgesBySourceHandle(edges);

    const result = identifyLoopBody("foreach", edgesBySource, nodes, handleMap);

    expect(result.bodyNodeIds).toContain("cond");
    expect(result.bodyNodeIds).toContain("action-a");
    expect(result.bodyNodeIds).toContain("action-b");
    expect(result.collectNodeId).toBe("collect");

    // Handle edges should be preserved in the body
    const condHandles = result.bodyEdgesBySourceHandle.get("cond");
    expect(condHandles).toBeDefined();
    expect(condHandles?.get("true")).toEqual(["action-a"]);
    expect(condHandles?.get("false")).toEqual(["action-b"]);
  });

  it("should filter handle targets to body-only nodes", () => {
    // For Each -> Condition -> (true: action-a, false: action-b)
    // action-a -> Collect, action-b -> Collect
    // Also add a handle edge to an unrelated node NOT reachable via edgesBySource
    const nodes = new Map<string, WorkflowNode>([
      ["foreach", makeNode("foreach", "For Each")],
      ["cond", makeNode("cond", "Condition")],
      ["action-a", makeNode("action-a", "Send Webhook")],
      ["action-b", makeNode("action-b", "Send Webhook")],
      ["collect", makeNode("collect", "Collect")],
      ["unrelated", makeNode("unrelated", "Send Webhook")],
    ]);

    // edgesBySource only connects through body nodes (no edge to "unrelated")
    const edges: MinimalEdge[] = [
      { source: "foreach", target: "cond" },
      { source: "cond", target: "action-a", sourceHandle: "true" },
      { source: "cond", target: "action-b", sourceHandle: "false" },
      { source: "action-a", target: "collect" },
      { source: "action-b", target: "collect" },
    ];

    const edgesBySource = edgesToSourceMap(edges);

    // Manually inject a handle edge pointing outside the body to simulate
    // a stale/orphaned handle target that the filter should remove
    const handleMap = buildEdgesBySourceHandle(edges);
    handleMap.get("cond")?.get("true")?.push("unrelated");

    const result = identifyLoopBody("foreach", edgesBySource, nodes, handleMap);

    // "unrelated" is not in bodyNodeIds (not reachable via BFS)
    expect(result.bodyNodeIds).not.toContain("unrelated");

    // The handle filter should strip "unrelated" from the true targets
    const condHandles = result.bodyEdgesBySourceHandle.get("cond");
    expect(condHandles?.get("true")).toEqual(["action-a"]);
    expect(condHandles?.get("false")).toEqual(["action-b"]);
  });

  it("should return empty handle map when no handle edges exist", () => {
    const nodes = new Map<string, WorkflowNode>([
      ["foreach", makeNode("foreach", "For Each")],
      ["action", makeNode("action", "Send Webhook")],
      ["collect", makeNode("collect", "Collect")],
    ]);

    const edges: MinimalEdge[] = [
      { source: "foreach", target: "action" },
      { source: "action", target: "collect" },
    ];

    const edgesBySource = edgesToSourceMap(edges);
    const handleMap = buildEdgesBySourceHandle(edges);

    const result = identifyLoopBody("foreach", edgesBySource, nodes, handleMap);

    expect(result.bodyEdgesBySourceHandle.size).toBe(0);
  });

  it("should work without handle map parameter (backward compat)", () => {
    const nodes = new Map<string, WorkflowNode>([
      ["foreach", makeNode("foreach", "For Each")],
      ["action", makeNode("action", "Send Webhook")],
      ["collect", makeNode("collect", "Collect")],
    ]);

    const edges: MinimalEdge[] = [
      { source: "foreach", target: "action" },
      { source: "action", target: "collect" },
    ];

    const edgesBySource = edgesToSourceMap(edges);

    // Omit the handle map entirely
    const result = identifyLoopBody("foreach", edgesBySource, nodes);

    expect(result.bodyNodeIds).toContain("action");
    expect(result.collectNodeId).toBe("collect");
    expect(result.bodyEdgesBySourceHandle.size).toBe(0);
  });

  it("should handle nested condition with multiple true targets", () => {
    // For Each -> Condition -> (true: a1, true: a2, false: a3) -> Collect
    const nodes = new Map<string, WorkflowNode>([
      ["foreach", makeNode("foreach", "For Each")],
      ["cond", makeNode("cond", "Condition")],
      ["a1", makeNode("a1", "Send Webhook")],
      ["a2", makeNode("a2", "Send Webhook")],
      ["a3", makeNode("a3", "Send Webhook")],
      ["collect", makeNode("collect", "Collect")],
    ]);

    const edges: MinimalEdge[] = [
      { source: "foreach", target: "cond" },
      { source: "cond", target: "a1", sourceHandle: "true" },
      { source: "cond", target: "a2", sourceHandle: "true" },
      { source: "cond", target: "a3", sourceHandle: "false" },
      { source: "a1", target: "collect" },
      { source: "a2", target: "collect" },
      { source: "a3", target: "collect" },
    ];

    const edgesBySource = edgesToSourceMap(edges);
    const handleMap = buildEdgesBySourceHandle(edges);

    const result = identifyLoopBody("foreach", edgesBySource, nodes, handleMap);

    const condHandles = result.bodyEdgesBySourceHandle.get("cond");
    expect(condHandles?.get("true")).toEqual(["a1", "a2"]);
    expect(condHandles?.get("false")).toEqual(["a3"]);
  });
});
