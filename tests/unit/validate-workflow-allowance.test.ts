import { describe, expect, it } from "vitest";

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
});
