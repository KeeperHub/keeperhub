import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BATCH_WRITE_CONTRACT_ACTION_TYPE } from "@/lib/mcp/action-type";
import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import { VALIDATION_WARNING_CODES } from "@/lib/mcp/validate-workflow-codes";

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

const writeNode = (
  id = "write-1",
  overrides: Record<string, unknown> = {},
  actionType = "web3/write-contract"
) => ({
  id,
  type: "action",
  data: {
    label: "Write Contract",
    type: "action",
    config: {
      actionType,
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "[]",
      abiFunction: "transfer",
      ...overrides,
    },
  },
});

const makeWorkflow = (
  overrides: Partial<ValidatorWorkflow> = {}
): ValidatorWorkflow => ({
  id: "wf-1",
  nodes: [triggerNode(), writeNode()],
  edges: [{ id: "e1", source: "trigger-1", target: "write-1" }],
  inputSchema: null,
  outputMapping: null,
  isListed: false,
  workflowType: "write",
  ...overrides,
});

const routingWarnings = (wf: ValidatorWorkflow) =>
  validateWorkflow(wf).warnings.filter(
    (w) => w.code === VALIDATION_WARNING_CODES.SIGNER_ROUTING_KEY_IGNORED
  );

// ---------------------------------------------------------------------------
// The fault this catches (issue #2431)
// ---------------------------------------------------------------------------

describe("validateWorkflow — signer routing key ignored", () => {
  it("warns when a write node sets integrationId and no web3Connection", () => {
    const result = routingWarnings(
      makeWorkflow({
        nodes: [
          triggerNode(),
          writeNode("write-1", { integrationId: "xv7x4qalziyodoir6wyu4" }),
        ],
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].parameterPath).toBe("nodes[1].config.integrationId");
  });

  it("names both fields, and does not enumerate the signer values", () => {
    const [warning] = routingWarnings(
      makeWorkflow({
        nodes: [
          triggerNode(),
          writeNode("write-1", { integrationId: "int_x" }),
        ],
      })
    );
    expect(warning.message).toContain("integrationId");
    expect(warning.message).toContain("web3Connection");
    // Listing the accepted values here would advertise "eoa", the branch
    // that bypasses org policy. Those belong in docs/agent/mcp-server.md.
    expect(warning.message).not.toContain("safe:");
  });

  it("stays a warning — the workflow is still valid", () => {
    const result = validateWorkflow(
      makeWorkflow({
        nodes: [
          triggerNode(),
          writeNode("write-1", { integrationId: "int_x" }),
        ],
      })
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deliberately NOT warned about. These are the false positives that make the
// broader "routing is unset" rule unshippable: omitting web3Connection is the
// documented default (org policy), so almost every real workflow omits it.
// ---------------------------------------------------------------------------

describe("validateWorkflow — signer routing, cases that must stay silent", () => {
  it("does not warn when neither key is set (the documented default path)", () => {
    expect(routingWarnings(makeWorkflow())).toEqual([]);
  });

  it("does not warn on a read node that carries integrationId", () => {
    expect(
      routingWarnings(
        makeWorkflow({
          workflowType: "read",
          nodes: [
            triggerNode(),
            writeNode(
              "read-1",
              { integrationId: "int_x" },
              "web3/read-contract"
            ),
          ],
          edges: [{ id: "e1", source: "trigger-1", target: "read-1" }],
        })
      )
    ).toEqual([]);
  });

  it("ignores an empty-string integrationId", () => {
    expect(
      routingWarnings(
        makeWorkflow({
          nodes: [triggerNode(), writeNode("write-1", { integrationId: "" })],
        })
      )
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The loophole the rule must not have. `parseWeb3Connection` maps missing,
// empty and "default" to one branch, so a rule that only fired when
// web3Connection were absent could be silenced by writing a value that
// changes nothing. `integrationId` is inert regardless of what sits beside it.
// ---------------------------------------------------------------------------

describe("validateWorkflow — integrationId warns regardless of web3Connection", () => {
  it.each([
    ["absent", undefined],
    ["an empty string", ""],
    ["default", "default"],
    ["eoa", "eoa"],
    ["a specific safe", "safe:sw_123"],
  ])("still warns when web3Connection is %s", (_label, value) => {
    const overrides: Record<string, unknown> = { integrationId: "int_x" };
    if (value !== undefined) {
      overrides.web3Connection = value;
    }
    expect(
      routingWarnings(
        makeWorkflow({
          nodes: [triggerNode(), writeNode("write-1", overrides)],
        })
      )
    ).toHaveLength(1);
  });

  it("never describes routing as unset, and never suggests eoa", () => {
    const [warning] = routingWarnings(
      makeWorkflow({
        nodes: [
          triggerNode(),
          writeNode("write-1", { integrationId: "int_x" }),
        ],
      })
    );
    // Absence routes to org policy, and "eoa" is the branch that bypasses it:
    // telling an agent routing is unset would point it at the bypass.
    expect(warning.message).not.toMatch(/unset|unrouted|no sender routing/i);
    expect(warning.message).not.toContain("eoa");
    expect(warning.message).toContain("remove it");
  });
});

// ---------------------------------------------------------------------------
// Sibling surfaces — a fix applied to one actionType and not its siblings is
// the failure mode ISSUES.md calls out, so every signed-write type is covered.
// ---------------------------------------------------------------------------

describe("validateWorkflow — signer routing across signed-write action types", () => {
  it.each([
    ["web3/write-contract", "web3/write-contract"],
    ["batch write-contract", BATCH_WRITE_CONTRACT_ACTION_TYPE],
    ["a protocol-write", "aave-v3/protocol-write-supply"],
    ["approve-token", "web3/approve-token"],
    ["transfer-funds", "web3/transfer-funds"],
    ["transfer-token", "web3/transfer-token"],
  ])("warns for %s", (_label, actionType) => {
    expect(
      routingWarnings(
        makeWorkflow({
          nodes: [
            triggerNode(),
            writeNode("write-1", { integrationId: "int_x" }, actionType),
          ],
        })
      )
    ).toHaveLength(1);
  });

  it("warns once per offending node, not once per workflow", () => {
    expect(
      routingWarnings(
        makeWorkflow({
          nodes: [
            triggerNode(),
            writeNode("write-1", { integrationId: "a" }),
            writeNode("write-2", { integrationId: "b" }),
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: "write-1" },
            { id: "e2", source: "write-1", target: "write-2" },
          ],
        })
      )
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Malformed input — the validator is pure and must not throw on junk.
// ---------------------------------------------------------------------------

describe("validateWorkflow — signer routing, malformed nodes", () => {
  it.each([
    ["nodes not an array", { nodes: "nope" as unknown as unknown[] }],
    ["a null node", { nodes: [null] as unknown[] }],
    ["a node with no data", { nodes: [{ id: "x" }] as unknown[] }],
    [
      "a node with null config",
      { nodes: [{ id: "x", data: { config: null } }] as unknown[] },
    ],
  ])("does not throw for %s", (_label, overrides) => {
    expect(() => validateWorkflow(makeWorkflow(overrides))).not.toThrow();
  });

  it("ignores a non-string integrationId", () => {
    expect(
      routingWarnings(
        makeWorkflow({
          nodes: [
            triggerNode(),
            writeNode("write-1", { integrationId: { id: "int_x" } }),
          ],
        })
      )
    ).toEqual([]);
  });
});
