import { describe, expect, it } from "vitest";

import {
  buildWorkflowExportV1,
  stripIntegrationsFromImportNodes,
  WORKFLOW_EXPORT_VERSION,
  workflowExportV1Schema,
} from "@/lib/workflow/export-schema";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

function makeTriggerNode(): WorkflowNode {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Manual Trigger",
      type: "trigger",
      config: { triggerType: "Manual" },
      status: "idle",
    },
  };
}

function makeActionNode(): WorkflowNode {
  return {
    id: "action-1",
    type: "action",
    position: { x: 200, y: 0 },
    data: {
      label: "Send Discord",
      type: "action",
      config: {
        actionType: "send-discord-message",
        integrationId: "8e2a5cf0-aaaa-bbbb-cccc-1234567890ab",
        integrationType: "discord",
        integrationConfig: {
          webhookUrl: "https://discord.example/webhook",
        },
        message: "hello",
      },
      status: "idle",
    },
  };
}

function makeEdge(): WorkflowEdge {
  return {
    id: "edge-1",
    source: "trigger-1",
    target: "action-1",
    type: "animated",
  };
}

describe("buildWorkflowExportV1", () => {
  it("strips integrationId and integrationConfig from action nodes", () => {
    const exportPayload = buildWorkflowExportV1({
      name: "test",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    });

    const actionNode = exportPayload.nodes.find((n) => n.id === "action-1");
    const config = actionNode?.data.config as Record<string, unknown>;

    expect(config.integrationId).toBeUndefined();
    expect(config.integrationConfig).toBeUndefined();
    expect(config.actionType).toBe("send-discord-message");
    expect(config.message).toBe("hello");
  });

  it("records an integrationBindings entry per action with an integrationType", () => {
    const exportPayload = buildWorkflowExportV1({
      name: "test",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    });

    expect(exportPayload.integrationBindings).toEqual([
      { nodeId: "action-1", integrationType: "discord" },
    ]);
  });

  it("preserves an empty-string description but omits null", () => {
    const empty = buildWorkflowExportV1({
      name: "x",
      description: "",
      nodes: [makeTriggerNode()],
      edges: [],
    });
    expect(empty.workflow).toEqual({ name: "x", description: "" });

    const nullDesc = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: [makeTriggerNode()],
      edges: [],
    });
    expect(nullDesc.workflow).toEqual({ name: "x" });
  });

  it("emits the current version literal and an ISO timestamp", () => {
    const exportPayload = buildWorkflowExportV1({
      name: "test",
      description: "demo",
      nodes: [makeTriggerNode()],
      edges: [],
    });

    expect(exportPayload.version).toBe(WORKFLOW_EXPORT_VERSION);
    expect(exportPayload.workflow).toEqual({
      name: "test",
      description: "demo",
    });
    expect(() => new Date(exportPayload.exportedAt)).not.toThrow();
  });
});

describe("workflowExportV1Schema", () => {
  it("accepts a payload produced by buildWorkflowExportV1", () => {
    const payload = buildWorkflowExportV1({
      name: "round-trip",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    });

    const parsed = workflowExportV1Schema.safeParse(payload);

    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown version", () => {
    const payload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: [makeTriggerNode()],
      edges: [],
    });

    const bad = { ...payload, version: 99 };
    const parsed = workflowExportV1Schema.safeParse(bad);

    expect(parsed.success).toBe(false);
  });

  it("rejects integrationBindings whose integrationType disagrees with the bound node", () => {
    const payload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    });

    const tampered = {
      ...payload,
      integrationBindings: [{ nodeId: "action-1", integrationType: "slack" }],
    };

    const parsed = workflowExportV1Schema.safeParse(tampered);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual([
        "integrationBindings",
        0,
        "integrationType",
      ]);
    }
  });

  it("rejects integrationBindings whose nodeId does not match any node", () => {
    const payload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    });

    const tampered = {
      ...payload,
      integrationBindings: [
        { nodeId: "ghost-node", integrationType: "discord" },
      ],
    };

    const parsed = workflowExportV1Schema.safeParse(tampered);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual([
        "integrationBindings",
        0,
        "nodeId",
      ]);
    }
  });

  it("rejects a missing required field", () => {
    const parsed = workflowExportV1Schema.safeParse({
      version: WORKFLOW_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      workflow: { name: "x" },
      nodes: [],
      // edges and integrationBindings missing
    });

    expect(parsed.success).toBe(false);
  });
});

describe("stripIntegrationsFromImportNodes", () => {
  it("strips integrationId and integrationConfig from imported node configs", () => {
    const payload = buildWorkflowExportV1({
      name: "x",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    });

    // Inject integrationId back to simulate a tampered/legacy export
    const injected = payload.nodes.map((n) => {
      if (n.id !== "action-1") {
        return n;
      }
      const config = (n.data.config ?? {}) as Record<string, unknown>;
      return {
        ...n,
        data: {
          ...n.data,
          config: { ...config, integrationId: "leaked-id" },
        },
      };
    });

    const stripped = stripIntegrationsFromImportNodes(
      injected as typeof payload.nodes
    );
    const action = stripped.find(
      (n) => (n as Record<string, unknown>).id === "action-1"
    ) as Record<string, unknown>;
    const data = action.data as Record<string, unknown>;
    const config = data.config as Record<string, unknown>;

    expect(config.integrationId).toBeUndefined();
    expect(config.integrationConfig).toBeUndefined();
  });
});

describe("export -> import round trip", () => {
  it("preserves node ids, types, and edge structure", () => {
    const original = {
      name: "round-trip",
      description: null,
      nodes: [makeTriggerNode(), makeActionNode()],
      edges: [makeEdge()],
    };

    const exportPayload = buildWorkflowExportV1(original);
    const parsed = workflowExportV1Schema.parse(exportPayload);
    const importNodes = stripIntegrationsFromImportNodes(parsed.nodes);

    expect(importNodes.map((n) => (n as Record<string, unknown>).id)).toEqual([
      "trigger-1",
      "action-1",
    ]);
    expect(parsed.edges.map((e) => e.id)).toEqual(["edge-1"]);
    expect(parsed.integrationBindings).toEqual([
      { nodeId: "action-1", integrationType: "discord" },
    ]);
  });
});
