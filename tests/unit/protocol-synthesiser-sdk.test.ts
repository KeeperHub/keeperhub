import { describe, expect, it, vi } from "vitest";
import { synthesiseProtocolForSDK } from "@/lib/workflow/codegen/protocol-synthesiser";

// Mock server-only before importing the SDK module: sdk.ts imports
// "server-only", which throws when loaded outside a server runtime.
vi.mock("server-only", () => ({}));

const { generateWorkflowSDKCode } = await import("@/lib/workflow/codegen/sdk");

import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const triggerNode: WorkflowNode = {
  id: "trigger-1",
  type: "trigger",
  position: { x: 0, y: 0 },
  data: {
    type: "trigger",
    label: "Manual Trigger",
    config: { triggerType: "Manual" },
  },
};

function ccipBalanceNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: "Check CCIP Balance",
      config: {
        actionType: "chainlink/ccip-check-bridge-balance",
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
        account: "0x1111111111111111111111111111111111111111",
      },
    },
  };
}

const edge = (s: string, t: string): WorkflowEdge => ({
  id: `${s}-${t}`,
  source: s,
  target: t,
});

describe("generateWorkflowSDKCode (protocol synthesis path)", () => {
  it("emits viem imports and inlines the synthesised body for a CCIP balance node", () => {
    const node = ccipBalanceNode("a-1");
    const code = generateWorkflowSDKCode(
      "ccip_balance_workflow",
      [triggerNode, node],
      [edge(triggerNode.id, node.id)]
    );

    process.stdout.write("\n=== SDK OUTPUT ===\n");
    process.stdout.write(`${code}\n`);

    expect(code).toContain('import { createPublicClient, http } from "viem"');
    expect(code).toContain('import { sepolia } from "viem/chains"');
    expect(code).toContain(
      'const CONTRACT_ADDRESS = "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05" as const;'
    );
    expect(code).toContain('functionName: "balanceOf"');
    // Body should reference stepInput.X (rebound from input.X by SDK helper)
    expect(code).toContain("args: [stepInput.account]");
    // stepInput should be constructed from config
    expect(code).toContain(
      "account: `0x1111111111111111111111111111111111111111`"
    );
    // Must not be the legacy stub
    expect(code).not.toContain("return { success: true };\n}");
  });

  it("scopes CONTRACT_ADDRESS per step so duplicate action nodes do not collide", () => {
    // Constants live inside each step function (not at file top), so two
    // CCIP balance nodes can coexist with independent CONTRACT_ADDRESS
    // bindings. Asserts the per-step scoping invariant.
    const node1 = ccipBalanceNode("a-1");
    const node2 = ccipBalanceNode("a-2");
    const code = generateWorkflowSDKCode(
      "two_balances",
      [triggerNode, node1, node2],
      [edge(triggerNode.id, node1.id), edge(node1.id, node2.id)]
    );

    // Each step function inlines its own CONTRACT_ADDRESS const
    const occurrences = code.match(/const CONTRACT_ADDRESS =/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});

describe("synthesiseProtocolForSDK (direct)", () => {
  it("returns null for non-protocol action ids", () => {
    expect(synthesiseProtocolForSDK("web3/check-balance")).toBeNull();
    expect(synthesiseProtocolForSDK("malformed-no-slash")).toBeNull();
  });

  it("returns the SDK shape for a CCIP balance read", () => {
    const out = synthesiseProtocolForSDK(
      "chainlink/ccip-check-bridge-balance",
      {
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
      }
    );

    expect(out).not.toBeNull();
    const sdk = out as NonNullable<typeof out>;

    // Imports include only viem read-side dependencies.
    expect(sdk.imports).toContain(
      'import { createPublicClient, http } from "viem";'
    );
    expect(sdk.imports).toContain('import { sepolia } from "viem/chains";');

    // ABI + address are inline declarations the SDK wrapper drops into the
    // step function body so per-step constants do not collide across nodes.
    expect(sdk.inlineDecls.length).toBe(2);
    expect(sdk.inlineDecls[0]).toContain("CONTRACT_ADDRESS");
    expect(sdk.inlineDecls[1]).toContain("const ABI = [");

    // Body must have been rebound from input.X to stepInput.X.
    const body = sdk.bodyLines.join("\n");
    expect(body).toContain("args: [stepInput.account]");
    expect(body).not.toContain("args: [input.account]");

    // Inputs descriptor mirrors the action.inputs the SDK uses to build
    // stepInput entries from node config.
    expect(sdk.inputs.map((i) => i.name)).toEqual(["account"]);
  });

  it("returns the SDK shape for a CCIP approve write (signer + simulate path)", () => {
    const out = synthesiseProtocolForSDK(
      "chainlink/ccip-approve-bridge-token",
      {
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
      }
    );

    expect(out).not.toBeNull();
    const sdk = out as NonNullable<typeof out>;

    expect(sdk.imports).toContain(
      'import { createPublicClient, createWalletClient, http } from "viem";'
    );
    expect(sdk.imports).toContain(
      'import { privateKeyToAccount } from "viem/accounts";'
    );

    const body = sdk.bodyLines.join("\n");
    expect(body).toContain("simulateContract");
    expect(body).toContain(
      "args: [stepInput.spender, BigInt(stepInput.amount)]"
    );
    expect(sdk.inputs.map((i) => i.name)).toEqual(["spender", "amount"]);
  });
});
