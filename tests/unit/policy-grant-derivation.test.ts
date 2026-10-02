import { describe, expect, it } from "vitest";
import { arnStringMatches } from "@/lib/policy/arn";
import { deriveWorkflowGrants } from "@/lib/policy/grant-derivation";

const action = (
  id: string,
  config: Record<string, unknown>
): { id: string; data: { type: string; config: Record<string, unknown> } } => ({
  id,
  data: { type: "action", config },
});

const READ_USDC = action("read", {
  actionType: "web3/read-contract",
  network: "8453",
  contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
});

describe("deriving what a workflow needs to reach", () => {
  it("names the contract a node reads, with the whole target covered", () => {
    const { grants } = deriveWorkflowGrants([READ_USDC]);
    expect(grants).toEqual([
      {
        resource:
          "kh:chain/8453/contract/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913/**",
        capabilities: ["contract.read"],
      },
    ]);
  });

  it("covers a call to any function on that contract", () => {
    const [grant] = deriveWorkflowGrants([READ_USDC]).grants;
    expect(
      arnStringMatches(
        grant.resource,
        "kh:chain/8453/contract/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913/fn/0x70a08231"
      )
    ).toBe(true);
  });

  it("does not cover the same address on another chain", () => {
    const [grant] = deriveWorkflowGrants([READ_USDC]).grants;
    expect(
      arnStringMatches(
        grant.resource,
        "kh:chain/1/contract/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913/fn/0x70a08231"
      )
    ).toBe(false);
  });

  it("leaves a Solana address exactly as written", () => {
    const { grants } = deriveWorkflowGrants([
      action("call", {
        actionType: "web3/call-solana-program-anchor",
        network: "101",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      }),
    ]);
    expect(grants[0]?.resource).toContain(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );
  });

  it("gathers every capability a workflow uses on one target", () => {
    const { grants } = deriveWorkflowGrants([
      READ_USDC,
      action("write", {
        actionType: "web3/write-contract",
        network: "8453",
        contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }),
    ]);
    expect(grants).toHaveLength(1);
    expect(grants[0].capabilities).toEqual(["contract.read", "contract.write"]);
  });

  it("reports a target it cannot pin rather than guessing one", () => {
    const { grants, unpinnable } = deriveWorkflowGrants([
      action("templated", {
        actionType: "web3/read-contract",
        network: "1",
        contractAddress: "{{@node1:Fetch.address}}",
      }),
    ]);
    expect(grants).toEqual([]);
    expect(unpinnable).toEqual([
      {
        nodeId: "templated",
        actionType: "web3/read-contract",
        field: "contractAddress",
      },
    ]);
  });

  it("ignores a trigger and an action with no onchain target", () => {
    const { grants, unpinnable } = deriveWorkflowGrants([
      { id: "t", data: { type: "trigger", config: { triggerType: "Manual" } } },
      action("http", {
        actionType: "HTTP Request",
        endpoint: "https://example.com",
      }),
    ]);
    expect(grants).toEqual([]);
    expect(unpinnable).toEqual([]);
  });
});
