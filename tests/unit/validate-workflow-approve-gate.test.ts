import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWorkflow } from "@/lib/mcp/validate-workflow";
import {
  actionNode,
  edge,
  makeWorkflow,
  triggerNode,
} from "./fixtures/validate-workflow";

const CODE = "approve-without-allowance-check";
const SPEND_CODE = "missing-allowance-preflight";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const OTHER_SPENDER = "0x1111111111111111111111111111111111111111";
const OTHER_TOKEN = "0x2222222222222222222222222222222222222222";
const MAX_UINT256 = (BigInt(2) ** BigInt(256) - BigInt(1)).toString();

const tokenConfig = (address: string) =>
  JSON.stringify({ mode: "custom", customToken: { address, symbol: "TKN" } });

const approveTokenNode = (
  id: string,
  overrides: Record<string, unknown> = {}
) =>
  actionNode(id, {
    actionType: "web3/approve-token",
    network: "1",
    tokenConfig: tokenConfig(WETH),
    spenderAddress: ROUTER,
    amount: "1000000",
    ...overrides,
  });

const writeApproveNode = (
  id: string,
  overrides: Record<string, unknown> = {}
) =>
  actionNode(id, {
    actionType: "web3/write-contract",
    contractAddress: WETH,
    abiFunction: "approve",
    functionArgs: JSON.stringify([ROUTER, "1000000"]),
    ...overrides,
  });

const checkAllowanceNode = (id = "ca") =>
  actionNode(id, { actionType: "web3/check-allowance" });

/** trigger-1 -> node, with extra nodes and edges layered on top. */
function chain(nodes: unknown[], edges: unknown[]) {
  return makeWorkflow({ workflowType: "write", nodes, edges });
}

const warningsOf = (result: {
  warnings: { code: string; parameterPath?: string; message: string }[];
}) => result.warnings.filter((w) => w.code === CODE);

describe("validateWorkflow - approve without allowance check", () => {
  it("warns on an approve-token node with no check-allowance upstream", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), approveTokenNode("a1")],
        [edge("e1", "trigger-1", "a1")]
      )
    );
    const [warning] = warningsOf(result);
    expect(warning).toBeDefined();
    expect(warning?.parameterPath).toBe("nodes[1].config.spenderAddress");
    expect(warning?.message).toContain(ROUTER.toLowerCase());
    expect(warning?.message).toContain("web3/check-allowance");
    // An exact amount is consumed by the spend after it, so the hint says it
    // is needed every run rather than calling it redundant.
    expect(warning?.message).toContain("exact amount");
    expect(warning?.message).toContain("not a redundancy claim");
    // The remedy names the Condition that consumes the read: the check alone
    // does not skip anything.
    expect(warning?.message).toContain("Condition");
  });

  it("says an unlimited approve re-grants an allowance already in place", () => {
    for (const amount of ["max", "MAX", MAX_UINT256]) {
      const result = validateWorkflow(
        chain(
          [triggerNode(), approveTokenNode("a1", { amount })],
          [edge("e1", "trigger-1", "a1")]
        )
      );
      const [warning] = warningsOf(result);
      expect(warning?.message).toContain("unlimited");
      expect(warning?.message).not.toContain("exact amount");
    }
  });

  it("makes no claim about the amount when it is a template or an argument it cannot read", () => {
    const templated = validateWorkflow(
      chain(
        [
          triggerNode(),
          approveTokenNode("a1", { amount: "{{@trigger-1:Trigger.amount}}" }),
        ],
        [edge("e1", "trigger-1", "a1")]
      )
    );
    const raw = validateWorkflow(
      chain(
        [triggerNode(), writeApproveNode("w1")],
        [edge("e1", "trigger-1", "w1")]
      )
    );
    for (const result of [templated, raw]) {
      const [warning] = warningsOf(result);
      expect(warning?.message).not.toContain("unlimited");
      expect(warning?.message).not.toContain("exact amount");
      expect(warning?.message).toContain("web3/check-allowance");
    }
  });

  it("reads a write-contract approve's spender from functionArgs, the key the editor writes", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), writeApproveNode("w1")],
        [edge("e1", "trigger-1", "w1")]
      )
    );
    const [warning] = warningsOf(result);
    expect(warning?.message).toContain(ROUTER.toLowerCase());
  });

  it("warns on a write-contract node calling approve with no check-allowance upstream", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), writeApproveNode("w1")],
        [edge("e1", "trigger-1", "w1")]
      )
    );
    const [warning] = warningsOf(result);
    expect(warning?.parameterPath).toBe("nodes[1].config.abiFunction");
  });

  it("strips the argument list from a full approve signature", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          writeApproveNode("w1", { abiFunction: "approve(address,uint256)" }),
        ],
        [edge("e1", "trigger-1", "w1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(1);
  });

  it("does not fire the spend-side warning for an approve (approve is a grant, not a spend)", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), writeApproveNode("w1")],
        [edge("e1", "trigger-1", "w1")]
      )
    );
    expect(result.warnings.some((w) => w.code === SPEND_CODE)).toBe(false);
  });

  it("is suppressed when a check-allowance node is upstream", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), checkAllowanceNode(), approveTokenNode("a1")],
        [edge("e1", "trigger-1", "ca"), edge("e2", "ca", "a1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(0);
  });

  it("still warns when the check-allowance node is on a branch that never reaches the approve", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), checkAllowanceNode(), approveTokenNode("a1")],
        [edge("e1", "trigger-1", "ca"), edge("e2", "trigger-1", "a1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(1);
  });

  it("still warns when the check-allowance node runs downstream of the approve", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), approveTokenNode("a1"), checkAllowanceNode()],
        [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "ca")]
      )
    );
    expect(warningsOf(result)).toHaveLength(1);
  });

  it("gates a write-contract approve through a check-allowance upstream as well", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), checkAllowanceNode(), writeApproveNode("w1")],
        [edge("e1", "trigger-1", "ca"), edge("e2", "ca", "w1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(0);
  });

  it("does not warn for a non-approve write (transfer)", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), writeApproveNode("w1", { abiFunction: "transfer" })],
        [edge("e1", "trigger-1", "w1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(0);
  });

  it("ignores approve on a read-contract node", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          writeApproveNode("r1", { actionType: "web3/read-contract" }),
        ],
        [edge("e1", "trigger-1", "r1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(0);
  });
});

describe("validateWorkflow - approve gate: an earlier approve of the same grant", () => {
  it("suppresses a second approve of the same token to the same spender", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), approveTokenNode("a1"), approveTokenNode("a2")],
        [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "a2")]
      )
    );
    // The first approve is still blind; the second has a grant to reason
    // about, so only the first warns.
    const warnings = warningsOf(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.parameterPath).toBe("nodes[1].config.spenderAddress");
  });

  it("matches addresses case-insensitively across approve-token and write-contract", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          writeApproveNode("w1", {
            contractAddress: WETH.toLowerCase(),
            functionArgs: JSON.stringify([ROUTER.toLowerCase(), "1"]),
          }),
          approveTokenNode("a2"),
        ],
        [edge("e1", "trigger-1", "w1"), edge("e2", "w1", "a2")]
      )
    );
    const warnings = warningsOf(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.parameterPath).toBe("nodes[1].config.abiFunction");
  });

  it("does not suppress when the earlier approve targets a different spender", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          approveTokenNode("a1", { spenderAddress: OTHER_SPENDER }),
          approveTokenNode("a2"),
        ],
        [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "a2")]
      )
    );
    expect(warningsOf(result)).toHaveLength(2);
  });

  it("does not suppress when the earlier approve is on a parallel branch", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), approveTokenNode("a1"), approveTokenNode("a2")],
        [edge("e1", "trigger-1", "a1"), edge("e2", "trigger-1", "a2")]
      )
    );
    expect(warningsOf(result)).toHaveLength(2);
  });

  it("does not suppress when the spender is a template reference on either node", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          approveTokenNode("a1", {
            spenderAddress: "{{@trigger-1:Trigger.spender}}",
          }),
          approveTokenNode("a2"),
        ],
        [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "a2")]
      )
    );
    expect(warningsOf(result)).toHaveLength(2);
  });

  it("does not let an approve on a cycle suppress itself", () => {
    const result = validateWorkflow(
      chain(
        [triggerNode(), approveTokenNode("a1"), approveTokenNode("a2")],
        [
          edge("e1", "trigger-1", "a1"),
          edge("e2", "a1", "a2"),
          edge("e3", "a2", "a1"),
        ]
      )
    );
    // Each is the other's ancestor through the cycle, so neither ran earlier
    // and neither suppresses the other.
    expect(warningsOf(result)).toHaveLength(2);
  });

  it("resolves the token from tokenConfig even when a legacy tokenAddress is present", () => {
    // The step ignores tokenAddress when tokenConfig exists; so does the gate,
    // otherwise two approves of different tokens could match as one grant.
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          approveTokenNode("a1", { tokenAddress: OTHER_TOKEN }),
          approveTokenNode("a2", {
            tokenConfig: tokenConfig(OTHER_TOKEN),
            tokenAddress: WETH,
          }),
        ],
        [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "a2")]
      )
    );
    expect(warningsOf(result)).toHaveLength(2);
  });

  it("does not suppress when the token is a platform-listed id rather than an address", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          approveTokenNode("a1", { tokenConfig: "usdc" }),
          approveTokenNode("a2", { tokenConfig: "usdc" }),
        ],
        [edge("e1", "trigger-1", "a1"), edge("e2", "a1", "a2")]
      )
    );
    expect(warningsOf(result)).toHaveLength(2);
  });
});

describe("validateWorkflow - approve gate on batch-write-contract", () => {
  const batchNode = (id: string, calls: unknown[]) =>
    actionNode(id, {
      actionType: "web3/batch-write-contract",
      calls: JSON.stringify(calls),
    });

  it("warns once per approve call in the batch, pointing at that call", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          batchNode("b1", [
            { contractAddress: WETH, abiFunction: "transfer", args: "[]" },
            {
              contractAddress: WETH,
              abiFunction: "approve",
              args: JSON.stringify([ROUTER, "1"]),
            },
          ]),
        ],
        [edge("e1", "trigger-1", "b1")]
      )
    );
    const warnings = warningsOf(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.parameterPath).toBe(
      "nodes[1].config.calls[1].abiFunction"
    );
  });

  it("is suppressed for the batch when a check-allowance node is upstream", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          checkAllowanceNode(),
          batchNode("b1", [
            {
              contractAddress: WETH,
              abiFunction: "approve",
              args: JSON.stringify([ROUTER, "1"]),
            },
          ]),
        ],
        [edge("e1", "trigger-1", "ca"), edge("e2", "ca", "b1")]
      )
    );
    expect(warningsOf(result)).toHaveLength(0);
  });

  it("treats an approve call inside an upstream batch as an earlier grant", () => {
    const result = validateWorkflow(
      chain(
        [
          triggerNode(),
          batchNode("b1", [
            {
              contractAddress: WETH,
              abiFunction: "approve",
              args: JSON.stringify([ROUTER, "1"]),
            },
          ]),
          approveTokenNode("a2"),
        ],
        [edge("e1", "trigger-1", "b1"), edge("e2", "b1", "a2")]
      )
    );
    const warnings = warningsOf(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.parameterPath).toBe(
      "nodes[1].config.calls[0].abiFunction"
    );
  });
});

describe("validateWorkflow - approve gate with no edges", () => {
  it("falls back to the presence test: a check-allowance node anywhere suppresses", () => {
    const result = validateWorkflow(
      chain([triggerNode(), checkAllowanceNode(), approveTokenNode("a1")], [])
    );
    expect(warningsOf(result)).toHaveLength(0);
  });

  it("does not treat an earlier approve as a gate without edges (no order to reason from)", () => {
    const result = validateWorkflow(
      chain([triggerNode(), approveTokenNode("a1"), approveTokenNode("a2")], [])
    );
    expect(warningsOf(result)).toHaveLength(2);
  });
});
