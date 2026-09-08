import { describe, expect, it } from "vitest";
import {
  getCommonFields,
  getTriggerFields,
} from "@/lib/workflow/editor/template-helpers";
import type { WorkflowNode } from "@/lib/workflow/store";

function manualTriggerNode(
  config: Record<string, unknown> = { triggerType: "Manual" }
): WorkflowNode {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Manual",
      type: "trigger",
      config,
    },
  };
}

const ADDRESS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    address: { type: "string", description: "Wallet address" },
  },
  required: ["address"],
};

describe("getTriggerFields with listing inputSchema", () => {
  it("returns base trigger fields when inputSchema is omitted", () => {
    const fields = getTriggerFields(manualTriggerNode());
    expect(fields.map((f) => f.field)).toEqual(["triggeredAt"]);
  });

  it("merges inputSchema fields under data.<name> for Manual trigger", () => {
    const fields = getTriggerFields(manualTriggerNode(), {
      inputSchema: ADDRESS_INPUT_SCHEMA,
    });
    expect(fields).toEqual([
      { field: "triggeredAt", description: expect.any(String) },
      { field: "data.address", description: "Wallet address" },
    ]);
  });

  it("merges inputSchema fields for Schedule trigger", () => {
    const fields = getTriggerFields(
      manualTriggerNode({ triggerType: "Schedule" }),
      { inputSchema: ADDRESS_INPUT_SCHEMA }
    );
    expect(fields.map((f) => f.field)).toEqual(["triggeredAt", "data.address"]);
  });

  it("does not double-list a field that already exists in the base set", () => {
    const fields = getTriggerFields(manualTriggerNode(), {
      inputSchema: {
        type: "object",
        properties: {
          triggeredAt: { type: "string" },
          address: { type: "string" },
        },
      },
    });
    const fieldNames = fields.map((f) => f.field);
    expect(fieldNames.filter((n) => n === "triggeredAt")).toHaveLength(1);
    expect(fieldNames).toContain("data.address");
    expect(fieldNames).toContain("data.triggeredAt");
  });

  it("falls back to default fields plus inputSchema when triggerType is missing", () => {
    const fields = getTriggerFields(manualTriggerNode({}), {
      inputSchema: ADDRESS_INPUT_SCHEMA,
    });
    expect(fields.map((f) => f.field)).toEqual([
      "triggered",
      "timestamp",
      "input",
      "data.address",
    ]);
  });
});

describe("getCommonFields routes inputSchema to trigger nodes only", () => {
  it("forwards options to getTriggerFields for trigger nodes", () => {
    const fields = getCommonFields(manualTriggerNode(), {
      inputSchema: ADDRESS_INPUT_SCHEMA,
    });
    expect(fields.map((f) => f.field)).toContain("data.address");
  });

  it("ignores inputSchema for action nodes", () => {
    const actionNode: WorkflowNode = {
      id: "action-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "HTTP Request",
        type: "action",
        config: { actionType: "HTTP Request" },
      },
    };
    const fields = getCommonFields(actionNode, {
      inputSchema: ADDRESS_INPUT_SCHEMA,
    });
    expect(fields.map((f) => f.field)).not.toContain("data.address");
  });
});
