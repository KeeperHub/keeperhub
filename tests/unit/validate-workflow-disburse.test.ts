import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWorkflow } from "@/lib/mcp/validate-workflow";
import {
  actionNode,
  edge,
  makeWorkflow,
  triggerNode,
} from "./fixtures/validate-workflow";

function disburse(web3Connection?: string) {
  return actionNode("d1", {
    actionType: "web3/disburse",
    network: "base-sepolia",
    assetType: "native",
    runKey: "payroll",
    legs: "[]",
    ...(web3Connection === undefined ? {} : { web3Connection }),
  });
}

function signerErrors(node: ReturnType<typeof disburse>) {
  const result = validateWorkflow(
    makeWorkflow({
      nodes: [triggerNode(), node],
      edges: [edge("e1", "trigger-1", "d1")],
    })
  );
  return result.errors.filter((e) => e.code === "disburse-signer-unsupported");
}

describe("validateWorkflow - disburse signer", () => {
  it("refuses a disburse node pinned to a Safe, with the reason", () => {
    const errors = signerErrors(disburse("safe:wallet-1"));
    expect(errors).toEqual([
      {
        code: "disburse-signer-unsupported",
        message: expect.stringContaining(
          "Safe and Role signers are not supported"
        ),
        parameterPath: "nodes[1].data.config.web3Connection",
      },
    ]);
  });

  it("accepts the default and the organization wallet", () => {
    for (const value of [undefined, "", "default", "eoa"]) {
      expect(signerErrors(disburse(value)), String(value)).toEqual([]);
    }
  });

  it("leaves other actions' Web3 Connection alone", () => {
    const node = actionNode("d1", {
      actionType: "web3/transfer-funds",
      web3Connection: "safe:wallet-1",
    });
    expect(signerErrors(node as ReturnType<typeof disburse>)).toEqual([]);
  });
});
