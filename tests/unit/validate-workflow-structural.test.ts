import { describe, expect, it } from "vitest";
import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import {
  SYSTEM_ACTIONS,
  TEMPLATE_SYNTAX,
  TRIGGERS,
} from "@/lib/mcp/workflow-schema-constants";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const triggerNode = (id = "trigger-1") => ({
  id,
  type: "trigger",
  data: {
    label: "Trigger",
    type: "trigger",
    config: { triggerType: "Manual" },
  },
});

const actionNode = (
  id = "action-1",
  overrides: Record<string, unknown> = {}
) => ({
  id,
  type: "action",
  data: {
    label: "Action",
    type: "action",
    config: { actionType: "web3/read-contract", ...overrides },
  },
});

const writeActionNode = (id = "write-1") => ({
  id,
  type: "action",
  data: {
    label: "Write Contract",
    type: "action",
    config: {
      actionType: "web3/write-contract",
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "[]",
      abiFunction: "transfer",
    },
  },
});

const edge = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
});

function makeWorkflow(
  overrides: Partial<ValidatorWorkflow> = {}
): ValidatorWorkflow {
  return {
    id: "wf-1",
    nodes: [triggerNode(), actionNode()],
    edges: [edge("e1", "trigger-1", "action-1")],
    inputSchema: { type: "object" },
    outputMapping: null,
    isListed: false,
    workflowType: "read",
    ...overrides,
  };
}

function buildLargeWorkflowFixture(nodeCount: number): ValidatorWorkflow {
  const nodes: unknown[] = [triggerNode("trigger-1")];
  const edges: unknown[] = [];
  let prev = "trigger-1";
  for (let i = 1; i < nodeCount; i++) {
    const id = `action-${i}`;
    nodes.push(actionNode(id));
    edges.push(edge(`e${i}`, prev, id));
    prev = id;
  }
  return {
    id: "wf-large",
    nodes,
    edges,
    inputSchema: { type: "object" },
    outputMapping: null,
    isListed: false,
    workflowType: "read",
  };
}

// ---------------------------------------------------------------------------
// Shared-constants module shape tests (Task 1 regression guards)
// ---------------------------------------------------------------------------

describe("TRIGGERS exports", () => {
  it("has exactly the 6 expected trigger keys", () => {
    const keys = Object.keys(TRIGGERS).sort();
    expect(keys).toEqual([
      "Block",
      "Event",
      "Manual",
      "Schedule",
      "Transfer",
      "Webhook",
    ]);
  });

  it("Event trigger outputFields contain eventName and address (Pitfall 2 guard)", () => {
    expect(TRIGGERS.Event.outputFields).toHaveProperty("eventName");
    expect(TRIGGERS.Event.outputFields).toHaveProperty("address");
  });

  it("Event trigger outputFields do NOT contain legacy field names event or contract", () => {
    const fields = Object.keys(TRIGGERS.Event.outputFields);
    expect(fields).not.toContain("event");
    expect(fields).not.toContain("contract");
  });
});

describe("SYSTEM_ACTIONS exports", () => {
  it("has exactly the 5 expected system action keys", () => {
    const keys = Object.keys(SYSTEM_ACTIONS).sort();
    expect(keys).toEqual([
      "Collect",
      "Condition",
      "Database Query",
      "For Each",
      "HTTP Request",
    ]);
  });
});

describe("TEMPLATE_SYNTAX exports", () => {
  it("has pattern, description, examples, and notes keys", () => {
    expect(TEMPLATE_SYNTAX).toHaveProperty("pattern");
    expect(TEMPLATE_SYNTAX).toHaveProperty("description");
    expect(TEMPLATE_SYNTAX).toHaveProperty("examples");
    expect(TEMPLATE_SYNTAX).toHaveProperty("notes");
  });
});

// ---------------------------------------------------------------------------
// VALID-02: Structural checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — empty-nodes-array (VALID-02)", () => {
  it("errors on empty nodes array", () => {
    const result = validateWorkflow(makeWorkflow({ nodes: [] }));
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.code === "empty-nodes-array");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes");
  });

  it("does not error when nodes array is non-empty", () => {
    const result = validateWorkflow(makeWorkflow());
    const err = result.errors.find((e) => e.code === "empty-nodes-array");
    expect(err).toBeUndefined();
  });
});

describe("validateWorkflow — unknown-edge-reference (VALID-02)", () => {
  it("errors when edge source does not match any node id", () => {
    const result = validateWorkflow(
      makeWorkflow({
        edges: [edge("e1", "ghost-node", "action-1")],
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.code === "unknown-edge-reference");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("edges[0].source");
    expect(err?.message).toContain("ghost-node");
  });

  it("errors when edge target does not match any node id", () => {
    const result = validateWorkflow(
      makeWorkflow({
        edges: [edge("e1", "trigger-1", "ghost-target")],
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.code === "unknown-edge-reference");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("edges[0].target");
  });

  it("does not error when all edges reference existing node ids", () => {
    const result = validateWorkflow(makeWorkflow());
    const err = result.errors.find((e) => e.code === "unknown-edge-reference");
    expect(err).toBeUndefined();
  });

  it("does not error when edges array is empty", () => {
    const result = validateWorkflow(makeWorkflow({ edges: [] }));
    const err = result.errors.find((e) => e.code === "unknown-edge-reference");
    expect(err).toBeUndefined();
  });
});

describe("validateWorkflow — missing-trigger-config (VALID-02)", () => {
  it("errors when no node has data.type === 'trigger'", () => {
    const result = validateWorkflow(
      makeWorkflow({
        nodes: [actionNode("action-only")],
        edges: [],
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.code === "missing-trigger-config");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes");
  });

  it("does not error when a trigger node is present", () => {
    const result = validateWorkflow(makeWorkflow());
    const err = result.errors.find((e) => e.code === "missing-trigger-config");
    expect(err).toBeUndefined();
  });
});

describe("validateWorkflow — bare-at-literal-in-template (VALID-02)", () => {
  it("errors when a node config contains a bare @ literal", () => {
    const result = validateWorkflow(
      makeWorkflow({
        nodes: [
          triggerNode(),
          actionNode("action-1", { address: "@trigger-1" }),
        ],
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "bare-at-literal-in-template"
    );
    expect(err).toBeDefined();
    expect(err?.message).toContain("@trigger-1");
    expect(err?.parameterPath).toBe("nodes");
  });

  it("does not error when all @ references are wrapped in {{...}}", () => {
    const result = validateWorkflow(
      makeWorkflow({
        nodes: [
          triggerNode(),
          actionNode("action-1", {
            address: "{{@trigger-1:Trigger.address}}",
          }),
        ],
      })
    );
    const err = result.errors.find(
      (e) => e.code === "bare-at-literal-in-template"
    );
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VALID-03: Listing-eligibility checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — missing-input-schema-on-listed (VALID-03)", () => {
  it("errors when isListed=true and inputSchema is null", () => {
    const result = validateWorkflow(
      makeWorkflow({ isListed: true, inputSchema: null })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "missing-input-schema-on-listed"
    );
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("inputSchema");
  });

  it("does not error when isListed=false and inputSchema is null", () => {
    const result = validateWorkflow(
      makeWorkflow({ isListed: false, inputSchema: null })
    );
    const err = result.errors.find(
      (e) => e.code === "missing-input-schema-on-listed"
    );
    expect(err).toBeUndefined();
  });

  it("does not error when isListed=true and inputSchema is present", () => {
    const result = validateWorkflow(
      makeWorkflow({
        isListed: true,
        inputSchema: { type: "object", properties: {} },
      })
    );
    const err = result.errors.find(
      (e) => e.code === "missing-input-schema-on-listed"
    );
    expect(err).toBeUndefined();
  });

  it("accepts an empty object as a valid inputSchema for zero-input listed workflows", () => {
    const result = validateWorkflow(
      makeWorkflow({ isListed: true, inputSchema: {} })
    );
    const err = result.errors.find(
      (e) => e.code === "missing-input-schema-on-listed"
    );
    expect(err).toBeUndefined();
  });
});

describe("validateWorkflow — unknown-output-mapping-node (VALID-03)", () => {
  it("errors when outputMapping references a nodeId not in nodes", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { result: "ghost-node" },
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("outputMapping.result");
    expect(err?.message).toContain("ghost-node");
  });

  it("errors when outputMapping uses {nodeId, field} shape with unknown nodeId", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { price: { nodeId: "missing-node", field: "data" } },
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeDefined();
    expect(err?.message).toContain("missing-node");
  });

  it("does not error when outputMapping references valid node ids", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { result: "action-1" },
      })
    );
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeUndefined();
  });

  it("does not error on flat {field, nodeId} shape when nodeId references a valid node", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { field: "result", nodeId: "action-1" },
      })
    );
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeUndefined();
  });

  it("errors on flat {field, nodeId} shape when nodeId is dangling", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { field: "result", nodeId: "ghost-node" },
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("outputMapping.nodeId");
    expect(err?.message).toContain("ghost-node");
  });

  it("does not error on keyed template-string shape referencing a valid node", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { result: "{{@action-1:Action.result}}" },
      })
    );
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeUndefined();
  });

  it("errors on keyed template-string shape referencing a dangling node", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { result: "{{@ghost-node:Ghost.result}}" },
      })
    );
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeDefined();
    expect(err?.message).toContain("ghost-node");
  });

  it("does not error when outputMapping is null", () => {
    const result = validateWorkflow(makeWorkflow({ outputMapping: null }));
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeUndefined();
  });

  it("silently skips non-string non-object outputMapping values (no false positives)", () => {
    const result = validateWorkflow(
      makeWorkflow({
        outputMapping: { count: 42 } as Record<string, unknown>,
      })
    );
    const err = result.errors.find(
      (e) => e.code === "unknown-output-mapping-node"
    );
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VALID-04: Write-action consistency
// ---------------------------------------------------------------------------

describe("validateWorkflow — missing-write-action-for-write-workflow (VALID-04)", () => {
  it("errors when workflowType=write but no write-action node is present", () => {
    const result = validateWorkflow(makeWorkflow({ workflowType: "write" }));
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "missing-write-action-for-write-workflow"
    );
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("workflowType");
  });

  it("does not error when workflowType=write and a write-action node is present", () => {
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [triggerNode(), writeActionNode()],
        edges: [edge("e1", "trigger-1", "write-1")],
      })
    );
    const err = result.errors.find(
      (e) => e.code === "missing-write-action-for-write-workflow"
    );
    expect(err).toBeUndefined();
  });
});

describe("validateWorkflow — explicit write-action classification (VALID-04)", () => {
  it.each([
    "web3/transfer-funds",
    "web3/transfer-token",
    "web3/approve-token",
    "safe/get-pending-transactions",
  ])("does not treat %s as an MCP-callable write", (actionType) => {
    const writeWorkflow = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [triggerNode(), actionNode("action-1", { actionType })],
        edges: [edge("e1", "trigger-1", "action-1")],
      })
    );

    expect(
      writeWorkflow.errors.some(
        (issue) => issue.code === "missing-write-action-for-write-workflow"
      )
    ).toBe(true);

    const readWorkflow = validateWorkflow(
      makeWorkflow({
        workflowType: "read",
        nodes: [triggerNode(), actionNode("action-1", { actionType })],
        edges: [edge("e1", "trigger-1", "action-1")],
      })
    );

    expect(
      readWorkflow.warnings.some(
        (issue) => issue.code === "write-action-on-read-workflow"
      )
    ).toBe(false);
  });

  it("uses the same protocol-write classifier as MCP calldata generation", () => {
    const actionType = "aave/protocol-write";
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [triggerNode(), actionNode("protocol-1", { actionType })],
        edges: [edge("e1", "trigger-1", "protocol-1")],
      })
    );

    expect(
      result.errors.some(
        (issue) => issue.code === "missing-write-action-for-write-workflow"
      )
    ).toBe(false);
  });
});

describe("validateWorkflow — write-action-on-read-workflow (VALID-04)", () => {
  it("emits a warning (not error) when workflowType=read but a write node is present", () => {
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "read",
        nodes: [triggerNode(), writeActionNode()],
        edges: [edge("e1", "trigger-1", "write-1")],
      })
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    const warn = result.warnings.find(
      (w) => w.code === "write-action-on-read-workflow"
    );
    expect(warn).toBeDefined();
    expect(warn?.parameterPath).toBe("workflowType");
  });

  it("does not warn when workflowType=read and no write node is present", () => {
    const result = validateWorkflow(makeWorkflow({ workflowType: "read" }));
    const warn = result.warnings.find(
      (w) => w.code === "write-action-on-read-workflow"
    );
    expect(warn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Happy-path: fully valid workflow
// ---------------------------------------------------------------------------

describe("validateWorkflow — happy path", () => {
  it("returns valid=true, nodeCount=2, empty errors and warnings for a clean workflow", () => {
    const result = validateWorkflow(makeWorkflow());
    expect(result).toEqual({
      valid: true,
      nodeCount: 2,
      errors: [],
      warnings: [],
    });
  });

  it("nodeCount reflects the actual number of nodes", () => {
    const result = validateWorkflow(
      makeWorkflow({
        nodes: [triggerNode(), actionNode("a1"), actionNode("a2")],
        edges: [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "a2")],
      })
    );
    expect(result.nodeCount).toBe(3);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Performance sanity check (Pitfall 3 guard — no accidental network/DB calls)
// ---------------------------------------------------------------------------

describe("validateWorkflow — performance", () => {
  it("completes 100 iterations over a 50-node fixture in <50ms", () => {
    const fixture = buildLargeWorkflowFixture(50);
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      validateWorkflow(fixture);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
