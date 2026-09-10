import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWorkflow } from "@/lib/mcp/validate-workflow";
import {
  actionNode,
  edge,
  makeWorkflow,
  triggerNode,
} from "./fixtures/validate-workflow";

const CODE = "missing-allowance-preflight";

const checkAllowanceNode = (id = "ca", actionType = "web3/check-allowance") =>
  actionNode(id, { actionType });

/**
 * trigger-1 -> w1, with `extraNodes` appended and `extraEdges` added on top.
 * An extra node with no edge to it is intentionally *not* upstream of w1.
 */
function writeWorkflow(
  overrides: Record<string, unknown>,
  extraNodes: unknown[] = [],
  extraEdges: unknown[] = []
) {
  return makeWorkflow({
    workflowType: "write",
    nodes: [
      triggerNode(),
      actionNode("w1", { actionType: "web3/write-contract", ...overrides }),
      ...extraNodes,
    ],
    edges: [edge("e1", "trigger-1", "w1"), ...extraEdges],
  });
}

/** trigger-1 -> ca -> w1: the check is genuinely upstream of the write. */
function gatedWriteWorkflow(
  overrides: Record<string, unknown>,
  gateActionType = "web3/check-allowance"
) {
  return makeWorkflow({
    workflowType: "write",
    nodes: [
      triggerNode(),
      checkAllowanceNode("ca", gateActionType),
      actionNode("w1", { actionType: "web3/write-contract", ...overrides }),
    ],
    edges: [edge("e1", "trigger-1", "ca"), edge("e2", "ca", "w1")],
  });
}

const hasWarning = (result: { warnings: { code: string }[] }) =>
  result.warnings.some((w) => w.code === CODE);

describe("validateWorkflow - allowance preflight", () => {
  it("warns when write-contract calls transferFrom with no check-allowance node", () => {
    const result = validateWorkflow(
      writeWorkflow({ abiFunction: "transferFrom" })
    );
    const warning = result.warnings.find((w) => w.code === CODE);
    expect(warning).toBeDefined();
    expect(warning?.parameterPath).toBe("nodes[1].config.abiFunction");
    expect(warning?.message).toContain("transferFrom");
    expect(warning?.message).toContain("web3/check-allowance");
  });

  it("strips the argument list from a full signature (redeem(...))", () => {
    const result = validateWorkflow(
      writeWorkflow({ abiFunction: "redeem(uint256,address,address)" })
    );
    expect(hasWarning(result)).toBe(true);
  });

  it("does not warn for a non-allowance method (transfer)", () => {
    const result = validateWorkflow(writeWorkflow({ abiFunction: "transfer" }));
    expect(hasWarning(result)).toBe(false);
  });

  it("is suppressed when a check-allowance node is upstream", () => {
    const result = validateWorkflow(
      gatedWriteWorkflow({ abiFunction: "transferFrom" })
    );
    expect(hasWarning(result)).toBe(false);
  });

  it("ignores allowance methods on a non-write action (read-contract)", () => {
    const result = validateWorkflow(
      makeWorkflow({
        nodes: [
          triggerNode(),
          actionNode("r1", {
            actionType: "web3/read-contract",
            abiFunction: "transferFrom",
          }),
        ],
        edges: [edge("e1", "trigger-1", "r1")],
      })
    );
    expect(hasWarning(result)).toBe(false);
  });

  it("ignores a top-level abiFunction on a batch-write-contract node (real batch nodes carry calls, not abiFunction)", () => {
    const result = validateWorkflow(
      writeWorkflow({
        actionType: "web3/batch-write-contract",
        abiFunction: "transferFrom",
      })
    );
    expect(hasWarning(result)).toBe(false);
  });

  it("warns when a batch-write-contract node's calls[] includes transferFrom with no check-allowance node", () => {
    const result = validateWorkflow(
      writeWorkflow({
        actionType: "web3/batch-write-contract",
        calls: JSON.stringify([
          { contractAddress: "0x1", abi: "[]", abiFunction: "transfer" },
          { contractAddress: "0x2", abi: "[]", abiFunction: "transferFrom" },
        ]),
      })
    );
    const warning = result.warnings.find((w) => w.code === CODE);
    expect(warning).toBeDefined();
    expect(warning?.parameterPath).toBe("nodes[1].config.calls[1].abiFunction");
    expect(warning?.message).toContain("transferFrom");
    expect(warning?.message).toContain("Multicall3");
  });

  it("does not warn when a batch-write-contract node's calls[] has no allowance-spend methods", () => {
    const result = validateWorkflow(
      writeWorkflow({
        actionType: "web3/batch-write-contract",
        calls: JSON.stringify([
          { contractAddress: "0x1", abi: "[]", abiFunction: "transfer" },
        ]),
      })
    );
    expect(hasWarning(result)).toBe(false);
  });

  it("suppresses the batch calls[] warning when a check-allowance node is upstream", () => {
    const result = validateWorkflow(
      gatedWriteWorkflow({
        actionType: "web3/batch-write-contract",
        calls: JSON.stringify([
          { contractAddress: "0x1", abi: "[]", abiFunction: "transferFrom" },
        ]),
      })
    );
    expect(hasWarning(result)).toBe(false);
  });
});

describe("validateWorkflow - allowance gate reachability", () => {
  it("warns when the check-allowance node is on a parallel branch that never reaches the write", () => {
    // trigger-1 -> ca (dead end), trigger-1 -> w1. Presence-based gating
    // suppressed this; the check cannot affect w1's execution.
    const result = validateWorkflow(
      writeWorkflow(
        { abiFunction: "transferFrom" },
        [checkAllowanceNode()],
        [edge("e2", "trigger-1", "ca")]
      )
    );
    expect(hasWarning(result)).toBe(true);
  });

  it("warns when the check-allowance node runs downstream of the write", () => {
    // trigger-1 -> w1 -> ca. Checking the allowance after spending it does not
    // prevent the revert.
    const result = validateWorkflow(
      writeWorkflow(
        { abiFunction: "transferFrom" },
        [checkAllowanceNode()],
        [edge("e2", "w1", "ca")]
      )
    );
    expect(hasWarning(result)).toBe(true);
  });

  it("suppresses through a multi-hop upstream chain", () => {
    // trigger-1 -> ca -> mid -> w1
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [
          triggerNode(),
          checkAllowanceNode(),
          actionNode("mid", { actionType: "web3/read-contract" }),
          actionNode("w1", {
            actionType: "web3/write-contract",
            abiFunction: "transferFrom",
          }),
        ],
        edges: [
          edge("e1", "trigger-1", "ca"),
          edge("e2", "ca", "mid"),
          edge("e3", "mid", "w1"),
        ],
      })
    );
    expect(hasWarning(result)).toBe(false);
  });

  it("gates each write independently: one branch checked, the other not", () => {
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [
          triggerNode(),
          checkAllowanceNode(),
          actionNode("gated", {
            actionType: "web3/write-contract",
            abiFunction: "transferFrom",
          }),
          actionNode("ungated", {
            actionType: "web3/write-contract",
            abiFunction: "transferFrom",
          }),
        ],
        edges: [
          edge("e1", "trigger-1", "ca"),
          edge("e2", "ca", "gated"),
          edge("e3", "trigger-1", "ungated"),
        ],
      })
    );
    const warnings = result.warnings.filter((w) => w.code === CODE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.parameterPath).toBe("nodes[3].config.abiFunction");
  });

  it("falls back to the presence test when the workflow carries no edges", () => {
    // Workflows whose edges were never persisted arrive as []. Less
    // information must not produce a more aggressive warning.
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [
          triggerNode(),
          checkAllowanceNode(),
          actionNode("w1", {
            actionType: "web3/write-contract",
            abiFunction: "transferFrom",
          }),
        ],
        edges: [],
      })
    );
    expect(hasWarning(result)).toBe(false);
  });

  it("still warns with no edges when there is no check-allowance node at all", () => {
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [
          triggerNode(),
          actionNode("w1", {
            actionType: "web3/write-contract",
            abiFunction: "transferFrom",
          }),
        ],
        edges: [],
      })
    );
    expect(hasWarning(result)).toBe(true);
  });

  it("terminates on a cycle in the edge graph", () => {
    // a -> b -> a, with w1 downstream of b and no check anywhere upstream.
    const result = validateWorkflow(
      makeWorkflow({
        workflowType: "write",
        nodes: [
          triggerNode(),
          checkAllowanceNode(),
          actionNode("a", { actionType: "web3/read-contract" }),
          actionNode("b", { actionType: "web3/read-contract" }),
          actionNode("w1", {
            actionType: "web3/write-contract",
            abiFunction: "transferFrom",
          }),
        ],
        edges: [
          edge("e1", "trigger-1", "ca"),
          edge("e2", "a", "b"),
          edge("e3", "b", "a"),
          edge("e4", "b", "w1"),
        ],
      })
    );
    expect(hasWarning(result)).toBe(true);
  });
});

describe("validateWorkflow - allowance gate action-type matching", () => {
  // chainlink/ccip-check-bridge-allowance and ccip-check-fee-allowance are
  // allowance(owner, spender) reads on an ERC-20, exactly what
  // web3/check-allowance does, but neither contains the contiguous substring
  // "check-allowance". Before this fix they did not register as gates.
  it.each([
    "chainlink/ccip-check-bridge-allowance",
    "chainlink/ccip-check-fee-allowance",
    "web3/check-allowance",
  ])("treats %s as an allowance gate when upstream", (actionType) => {
    const result = validateWorkflow(
      gatedWriteWorkflow({ abiFunction: "transferFrom" }, actionType)
    );
    expect(hasWarning(result)).toBe(false);
  });

  it.each([
    "chainlink/ccip-check-bridge-allowance",
    "chainlink/ccip-check-fee-allowance",
    "web3/check-allowance",
  ])("still warns when %s is not upstream of the write", (actionType) => {
    const result = validateWorkflow(
      writeWorkflow(
        { abiFunction: "transferFrom" },
        [checkAllowanceNode("ca", actionType)],
        [edge("e2", "trigger-1", "ca")]
      )
    );
    expect(hasWarning(result)).toBe(true);
  });

  it.each([
    // Grant an allowance rather than read one: an ERC-20 extension exposing
    // increaseAllowance / decreaseAllowance slugs to these.
    "erc20/increase-allowance",
    "erc20/decrease-allowance",
    // Unrelated actions that merely mention one of the words.
    "chainlink/ccip-approve-fee-token",
    "web3/approve-token",
    "aave-v3/supply",
  ])("does not treat %s as an allowance gate", (actionType) => {
    const result = validateWorkflow(
      gatedWriteWorkflow({ abiFunction: "transferFrom" }, actionType)
    );
    expect(hasWarning(result)).toBe(true);
  });
});
