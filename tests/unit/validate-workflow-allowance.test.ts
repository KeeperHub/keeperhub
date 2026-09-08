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

function writeWorkflow(
  overrides: Record<string, unknown>,
  extraNodes: unknown[] = []
) {
  return makeWorkflow({
    workflowType: "write",
    nodes: [
      triggerNode(),
      actionNode("w1", { actionType: "web3/write-contract", ...overrides }),
      ...extraNodes,
    ],
    edges: [edge("e1", "trigger-1", "w1")],
  });
}

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
    expect(result.warnings.some((w) => w.code === CODE)).toBe(true);
  });

  it("does not warn for a non-allowance method (transfer)", () => {
    const result = validateWorkflow(writeWorkflow({ abiFunction: "transfer" }));
    expect(result.warnings.some((w) => w.code === CODE)).toBe(false);
  });

  it("is suppressed when a check-allowance node is present", () => {
    const result = validateWorkflow(
      writeWorkflow({ abiFunction: "transferFrom" }, [
        actionNode("ca", { actionType: "web3/check-allowance" }),
      ])
    );
    expect(result.warnings.some((w) => w.code === CODE)).toBe(false);
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
    expect(result.warnings.some((w) => w.code === CODE)).toBe(false);
  });

  it("ignores a top-level abiFunction on a batch-write-contract node (real batch nodes carry calls, not abiFunction)", () => {
    const result = validateWorkflow(
      writeWorkflow({
        actionType: "web3/batch-write-contract",
        abiFunction: "transferFrom",
      })
    );
    expect(result.warnings.some((w) => w.code === CODE)).toBe(false);
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
    expect(result.warnings.some((w) => w.code === CODE)).toBe(false);
  });

  it("suppresses the batch calls[] warning when a check-allowance node is present", () => {
    const result = validateWorkflow(
      writeWorkflow(
        {
          actionType: "web3/batch-write-contract",
          calls: JSON.stringify([
            { contractAddress: "0x1", abi: "[]", abiFunction: "transferFrom" },
          ]),
        },
        [actionNode("ca", { actionType: "web3/check-allowance" })]
      )
    );
    expect(result.warnings.some((w) => w.code === CODE)).toBe(false);
  });
});
