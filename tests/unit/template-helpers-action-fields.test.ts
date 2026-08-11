import { describe, expect, it } from "vitest";
import {
  getActionFields,
  getCommonFields,
} from "@/lib/workflow/editor/template-helpers";
import type { WorkflowNode } from "@/lib/workflow/store";

function actionNode(
  config: Record<string, unknown>,
  overrides: Partial<WorkflowNode> = {}
): WorkflowNode {
  return {
    id: "action-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Action",
      type: "action",
      config,
    },
    ...overrides,
  };
}

describe("getActionFields - For Each", () => {
  it("returns currentItem, index, and totalItems for For Each nodes", () => {
    const fields = getActionFields(actionNode({ actionType: "For Each" }));
    expect(fields?.map((f) => f.field)).toEqual([
      "currentItem",
      "index",
      "totalItems",
    ]);
  });

  it("attaches a description to each For Each field", () => {
    const fields = getActionFields(actionNode({ actionType: "For Each" }));
    for (const field of fields ?? []) {
      expect(field.description.length).toBeGreaterThan(0);
    }
  });
});

describe("getActionFields - Collect", () => {
  it("returns results and count for Collect nodes", () => {
    const fields = getActionFields(actionNode({ actionType: "Collect" }));
    expect(fields?.map((f) => f.field)).toEqual(["results", "count"]);
  });

  it("describes results as an array of per-iteration outputs", () => {
    const fields = getActionFields(actionNode({ actionType: "Collect" }));
    const resultsField = fields?.find((f) => f.field === "results");
    expect(resultsField?.description).toMatch(/iteration/i);
  });

  it("describes count as the number of completed iterations", () => {
    const fields = getActionFields(actionNode({ actionType: "Collect" }));
    const countField = fields?.find((f) => f.field === "count");
    expect(countField?.description).toMatch(/iteration/i);
  });
});

describe("getCommonFields exposes Collect and For Each fields for action nodes", () => {
  it("returns Collect.results and Collect.count via getCommonFields", () => {
    const fields = getCommonFields(actionNode({ actionType: "Collect" }));
    const fieldNames = fields.map((f) => f.field);
    expect(fieldNames).toContain("results");
    expect(fieldNames).toContain("count");
    expect(fieldNames).not.toContain("data");
  });

  it("returns For Each loop variables via getCommonFields", () => {
    const fields = getCommonFields(actionNode({ actionType: "For Each" }));
    const fieldNames = fields.map((f) => f.field);
    expect(fieldNames).toEqual(["currentItem", "index", "totalItems"]);
  });

  it("falls back to data for unknown action types", () => {
    const fields = getCommonFields(
      actionNode({ actionType: "SomeUnregisteredAction" })
    );
    expect(fields).toEqual([{ field: "data", description: "Output data" }]);
  });
});
