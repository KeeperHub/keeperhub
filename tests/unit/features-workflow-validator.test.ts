import { describe, expect, it } from "vitest";

import {
  extractActionTypeNodes,
  validateWorkflowFeatures,
  type WorkflowNodeRef,
} from "@/lib/features";

const gatedNodes: WorkflowNodeRef[] = [
  { id: "n1", actionType: "Database Query" },
  { id: "n2", actionType: "HTTP Request" },
  { id: "n3", actionType: "code/run-code" },
  { id: "n4", actionType: "webhook/send-webhook" },
];

const ungatedNodes: WorkflowNodeRef[] = [
  { id: "u1", actionType: "Condition" },
  { id: "u2", actionType: "For Each" },
];

describe("validateWorkflowFeatures", () => {
  it("returns no violations when all nodes are ungated", () => {
    const result = validateWorkflowFeatures(ungatedNodes, "free");
    expect(result).toEqual([]);
  });

  it("returns no violations for pro plan running gated nodes", () => {
    const result = validateWorkflowFeatures(gatedNodes, "pro");
    expect(result).toEqual([]);
  });

  it("returns one violation per gated feature for free plan", () => {
    const result = validateWorkflowFeatures(gatedNodes, "free");
    const featureIds = result.map((v) => v.featureId).sort();
    expect(featureIds).toEqual(
      [
        "action.database-query",
        "action.http-request",
        "action.code",
        "action.webhook",
      ].sort()
    );
  });

  it("groups multiple nodes of the same gated action into one violation", () => {
    const nodes: WorkflowNodeRef[] = [
      { id: "a", actionType: "Database Query" },
      { id: "b", actionType: "Database Query" },
      { id: "c", actionType: "HTTP Request" },
    ];
    const result = validateWorkflowFeatures(nodes, "free");

    const dbViolation = result.find(
      (v) => v.featureId === "action.database-query"
    );
    expect(dbViolation?.nodeIds.sort()).toEqual(["a", "b"]);

    const httpViolation = result.find(
      (v) => v.featureId === "action.http-request"
    );
    expect(httpViolation?.nodeIds).toEqual(["c"]);
  });

  it("ignores unknown action types", () => {
    const nodes: WorkflowNodeRef[] = [
      { id: "x", actionType: "Made Up Action" },
    ];
    expect(validateWorkflowFeatures(nodes, "free")).toEqual([]);
  });
});

describe("extractActionTypeNodes", () => {
  it("extracts id + actionType from workflow JSONB-shaped nodes", () => {
    const raw = [
      { id: "n1", data: { config: { actionType: "Database Query" } } },
      { id: "n2", data: { config: { actionType: "Condition" } } },
    ];
    expect(extractActionTypeNodes(raw)).toEqual([
      { id: "n1", actionType: "Database Query" },
      { id: "n2", actionType: "Condition" },
    ]);
  });

  it("skips nodes missing id or actionType", () => {
    const raw = [
      { id: "n1" },
      { data: { config: { actionType: "HTTP Request" } } },
      { id: "n3", data: { config: {} } },
      null,
      "garbage",
      { id: "n4", data: { config: { actionType: 42 } } },
    ];
    expect(extractActionTypeNodes(raw)).toEqual([]);
  });

  it("returns empty array for non-array nodes input", () => {
    expect(extractActionTypeNodes({})).toEqual([]);
    expect(extractActionTypeNodes(null)).toEqual([]);
  });

  it("reads legacy top-level data.actionType", () => {
    const raw = [{ id: "n1", data: { actionType: "Database Query" } }];
    expect(extractActionTypeNodes(raw)).toEqual([
      { id: "n1", actionType: "Database Query" },
    ]);
  });

  it("normalizes colon-separated action types", () => {
    const raw = [
      { id: "n1", data: { config: { actionType: "code:run-code" } } },
    ];
    expect(extractActionTypeNodes(raw)).toEqual([
      { id: "n1", actionType: "code/run-code" },
    ]);
  });
});
