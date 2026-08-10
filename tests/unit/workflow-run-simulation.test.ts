import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const spies = vi.hoisted(() => ({
  simulateContractCall: vi.fn(),
  simulateNativeTransfer: vi.fn(),
  simulateTokenTransfer: vi.fn(),
  getChainIdFromNetwork: vi.fn(),
  isSolanaChain: vi.fn(),
  resolveSignerForNode: vi.fn(),
}));

vi.mock("@/lib/execute/simulate", () => ({
  simulateContractCall: spies.simulateContractCall,
  simulateNativeTransfer: spies.simulateNativeTransfer,
  simulateTokenTransfer: spies.simulateTokenTransfer,
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: spies.getChainIdFromNetwork,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  isSolanaChain: spies.isSolanaChain,
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: {
    EOA: "eoa",
    SAFE: "safe",
    SAFE_ROLE: "safe-role",
  },
  parseWeb3Connection: (value?: string | null) => {
    if (!value || value === "default") {
      return { kind: "default" };
    }
    if (value === "eoa") {
      return { kind: "eoa" };
    }
    if (value.startsWith("safe:") && value.length > "safe:".length) {
      return { kind: "safe", safeWalletId: value.slice("safe:".length) };
    }
    throw new Error(`Invalid web3Connection value '${value}'`);
  },
  resolveSignerForNode: spies.resolveSignerForNode,
}));

import {
  runWorkflowSimulation,
  WorkflowSimulationDeadlineError,
  type WorkflowSimulationNode,
} from "@/lib/workflow/run-simulation";

const SUCCESS_RESULT = {
  success: true,
  status: "simulated" as const,
  from: "0xaa0000000000000000000000000000000000aa00",
  to: "0xbb0000000000000000000000000000000000bb00",
  value: "0",
  gasEstimate: "21000",
  simulatedReturnValue: null,
  wouldRevert: false as const,
};

function triggerNode(id = "trigger-1"): WorkflowSimulationNode {
  return {
    id,
    type: "trigger",
    data: {
      type: "trigger",
      label: "Trigger",
      config: { triggerType: "Manual" },
    },
  };
}

function actionNode(
  id: string,
  actionType: string,
  config: Record<string, unknown> = {},
  options?: { enabled?: boolean; label?: string }
): WorkflowSimulationNode {
  return {
    id,
    type: "action",
    data: {
      type: "action",
      enabled: options?.enabled,
      label: options?.label ?? actionType,
      config: {
        actionType,
        network: "1",
        web3Connection: "eoa",
        ...config,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.getChainIdFromNetwork.mockReturnValue(1);
  spies.isSolanaChain.mockReturnValue(false);
  spies.resolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xaa0000000000000000000000000000000000aa00",
  });
  spies.simulateContractCall.mockResolvedValue(SUCCESS_RESULT);
  spies.simulateNativeTransfer.mockResolvedValue(SUCCESS_RESULT);
  spies.simulateTokenTransfer.mockResolvedValue(SUCCESS_RESULT);
});

describe("runWorkflowSimulation", () => {
  it("simulates a static EOA native transfer", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "0.1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result).toEqual({
      warnings: [],
      simulatedNodeCount: 1,
      skippedNodeCount: 0,
    });

    expect(spies.simulateNativeTransfer).toHaveBeenCalledWith({
      organizationId: "org_test",
      network: "1",
      amount: "0.1",
      recipientAddress: "0xbb0000000000000000000000000000000000bb00",
    });
  });

  it("turns a confirmed revert into a non-blocking warning", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "revert",
      wouldRevert: true,
      revertReason: "InsufficientBalance()",
      error: "InsufficientBalance()",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode(
          "transfer-1",
          "web3/transfer-funds",
          {
            amount: "100",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          },
          { label: "Pay supplier" }
        ),
      ],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_WOULD_REVERT",
      nodeId: "transfer-1",
      fieldKey: "amount",
      parameterPath: "nodes[0].data.config.amount",
    });
    expect(result.warnings[0]?.message).toBe(
      "Pay supplier would revert: InsufficientBalance()"
    );
    expect(result.warnings[0]?.message).not.toContain("CALL_EXCEPTION");
    expect(result.warnings[0]?.message).not.toContain("transaction={");
    expect(result).not.toHaveProperty("errors");
  });

  it("preserves a useful decoded revert reason and uses a readable action name", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "revert",
      wouldRevert: true,
      revertReason: "InsufficientBalance()",
      error: "InsufficientBalance()",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "100",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toBe(
      "Transfer Native Token would revert: InsufficientBalance()"
    );
  });

  it("replaces raw ethers revert details with actionable guidance", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "revert",
      wouldRevert: true,
      revertReason:
        'Simulation failed: missing revert data (action="estimateGas", transaction={"from":"0xaa"}, code=CALL_EXCEPTION)',
      error:
        'Simulation failed: missing revert data (action="estimateGas", transaction={"from":"0xaa"}, code=CALL_EXCEPTION)',
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "100",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toBe(
      "Transfer Native Token would revert. Check the wallet balance, amount, recipient, and gas requirements."
    );
    expect(result.warnings[0]?.message).not.toContain("missing revert data");
    expect(result.warnings[0]?.message).not.toContain("CALL_EXCEPTION");
    expect(result.warnings[0]?.message).not.toContain("transaction=");
  });

  it("turns RPC unavailability into a non-blocking warning", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "100",
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "100",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_UNAVAILABLE",
      nodeId: "transfer-1",
      fieldKey: "network",
      parameterPath: "nodes[0].data.config.network",
      message:
        "Transfer Native Token could not be simulated because the RPC service was unavailable. You can still run the workflow.",
    });
    expect(result.warnings[0]?.message).not.toContain(
      "All RPC providers failed"
    );
    expect(result.skippedNodeCount).toBe(1);
  });

  it("does not simulate a node whose transaction depends on runtime templates", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "{{Get Amount.value}}",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_DYNAMIC_INPUT",
      fieldKey: "amount",
      nodeId: "transfer-1",
    });
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("does not simulate an explicitly Safe-routed write", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          web3Connection: "safe:safe_wallet_1",
        }),
      ],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("SIMULATION_SAFE_SIGNER_UNSUPPORTED");
    expect(spies.resolveSignerForNode).not.toHaveBeenCalled();
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("does not simulate an EVM-only preflight on Solana", async () => {
    spies.getChainIdFromNetwork.mockReturnValueOnce(101);
    spies.isSolanaChain.mockReturnValueOnce(true);

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          network: "101",
          amount: "1",
          recipientAddress: "SolanaRecipient",
        }),
      ],
    });

    expect(result.warnings[0]?.code).toBe("SIMULATION_UNSUPPORTED_CHAIN");
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("skips disabled and unsupported action nodes silently", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode(
          "disabled-transfer",
          "web3/transfer-funds",
          {
            amount: "1",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          },
          { enabled: false }
        ),
        actionNode("email-1", "email/send-email"),
      ],
    });

    expect(result).toEqual({
      warnings: [],
      simulatedNodeCount: 0,
      skippedNodeCount: 0,
    });
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("maps a write-contract node to simulateContractCall", async () => {
    const abi = [
      {
        type: "function",
        name: "setValue",
        stateMutability: "nonpayable",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [],
      },
    ];

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("write-1", "web3/write-contract", {
          contractAddress: "0xbb0000000000000000000000000000000000bb00",
          abi,
          abiFunction: "setValue",
          functionArgs: ["123"],
          ethValue: "0",
        }),
      ],
    });

    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateContractCall).toHaveBeenCalledWith({
      organizationId: "org_test",
      network: "1",
      contractAddress: "0xbb0000000000000000000000000000000000bb00",
      abi: JSON.stringify(abi),
      functionName: "setValue",
      functionArgs: JSON.stringify(["123"]),
      value: "0",
    });
  });

  it("supports the legacy functionName field on write-contract nodes", async () => {
    const abi = [
      {
        type: "function",
        name: "setValue",
        stateMutability: "nonpayable",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [],
      },
    ];

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("write-legacy", "web3/write-contract", {
          contractAddress: "0xbb0000000000000000000000000000000000bb00",
          abi,
          functionName: "setValue",
          functionArgs: ["123"],
        }),
      ],
    });

    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "setValue" })
    );
  });

  it("maps a token-transfer node to simulateTokenTransfer", async () => {
    const tokenConfig = {
      supportedTokenId: "usdc-mainnet",
    };

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("token-1", "web3/transfer-token", {
          tokenConfig,
          amount: "12.5",
          decimals: 6,
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateTokenTransfer).toHaveBeenCalledWith({
      organizationId: "org_test",
      network: "1",
      tokenConfig: JSON.stringify(tokenConfig),
      tokenAddress: undefined,
      amount: "12.5",
      decimals: 6,
      recipientAddress: "0xbb0000000000000000000000000000000000bb00",
    });
  });

  it("supports legacy nodes with actionType at data.actionType", async () => {
    const legacyNode: WorkflowSimulationNode = {
      id: "legacy-transfer",
      type: "action",
      data: {
        type: "action",
        actionType: "web3/transfer-funds",
        config: {
          network: "1",
          web3Connection: "eoa",
          amount: "0.5",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        },
      },
    };

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [legacyNode],
    });

    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateNativeTransfer).toHaveBeenCalledTimes(1);
  });

  it("ignores disconnected write nodes when workflow edges are provided", async () => {
    const connected = actionNode("connected", "web3/transfer-funds", {
      amount: "1",
      recipientAddress: "0xbb0000000000000000000000000000000000bb00",
    });
    const disconnected = actionNode("disconnected", "web3/transfer-funds", {
      amount: "2",
      recipientAddress: "0xcc0000000000000000000000000000000000cc00",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [triggerNode(), connected, disconnected],
      edges: [{ source: "trigger-1", target: "connected" }],
    });

    expect(result.simulatedNodeCount).toBe(1);
    expect(spies.simulateNativeTransfer).toHaveBeenCalledTimes(1);
    expect(spies.simulateNativeTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "1" })
    );
  });

  it("resolves default signer mode without recording execution metrics", async () => {
    spies.resolveSignerForNode.mockResolvedValueOnce({
      kind: "safe",
      ownerAddress: "0xaa0000000000000000000000000000000000aa00",
      safeAddress: "0xdd0000000000000000000000000000000000dd00",
      safeWalletId: "safe-1",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          web3Connection: "default",
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(spies.resolveSignerForNode).toHaveBeenCalledWith({
      organizationId: "org_test",
      chainId: 1,
      web3Connection: "default",
      recordMetrics: false,
    });
    expect(result.warnings[0]?.code).toBe("SIMULATION_SAFE_SIGNER_UNSUPPORTED");
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("warns when the default signer cannot be resolved", async () => {
    spies.resolveSignerForNode.mockRejectedValueOnce(new Error("db down"));

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          web3Connection: "default",
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings[0]?.code).toBe("SIMULATION_SIGNER_UNAVAILABLE");
    expect(result.skippedNodeCount).toBe(1);
  });

  it("returns a warning for an invalid Web3 connection", async () => {
    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          web3Connection: "invalid-connection",
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_INVALID_WEB3_CONNECTION",
      fieldKey: "web3Connection",
    });
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("returns a warning for an invalid network", async () => {
    spies.getChainIdFromNetwork.mockImplementationOnce(() => {
      throw new Error("Unsupported network");
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          network: "not-a-network",
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_INVALID_NETWORK",
      fieldKey: "network",
    });
    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });

  it("turns an unexpected simulator throw into a warning", async () => {
    spies.simulateNativeTransfer.mockRejectedValueOnce(new Error("boom"));

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings[0]?.code).toBe("SIMULATION_UNAVAILABLE");
    expect(result.skippedNodeCount).toBe(1);
  });

  it("turns simulator validation failures into transaction warnings", async () => {
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "0",
      failureKind: "validation",
      wouldRevert: true,
      revertReason: "Invalid amount",
      error: "Invalid amount",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "bad",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_INVALID_TRANSACTION",
      fieldKey: "amount",
    });
  });

  it("warns that a later write may depend on an earlier workflow step", async () => {
    spies.simulateNativeTransfer
      .mockResolvedValueOnce({
        success: true,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        to: "0xbb0000000000000000000000000000000000bb00",
        value: "1",
        wouldRevert: false,
      })
      .mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        to: "0xcc0000000000000000000000000000000000cc00",
        value: "2",
        failureKind: "revert",
        wouldRevert: true,
        revertReason: "InsufficientBalance()",
        error: "InsufficientBalance()",
      });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        triggerNode(),
        actionNode("write-1", "web3/transfer-funds", {
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
        actionNode("write-2", "web3/transfer-funds", {
          amount: "2",
          recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        }),
      ],
      edges: [
        { source: "trigger-1", target: "write-1" },
        { source: "write-1", target: "write-2" },
      ],
    });

    expect(spies.simulateNativeTransfer).toHaveBeenCalledTimes(2);
    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_WOULD_REVERT",
      nodeId: "write-2",
    });
    expect(result.warnings[0]?.message).toContain(
      "This may depend on an earlier step in this workflow."
    );
  });

  it("stops when the workflow simulation deadline has already passed", async () => {
    await expect(
      runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          actionNode("transfer-1", "web3/transfer-funds", {
            amount: "1",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          }),
        ],
        deadlineAt: Date.now() - 1,
      })
    ).rejects.toBeInstanceOf(WorkflowSimulationDeadlineError);

    expect(spies.simulateNativeTransfer).not.toHaveBeenCalled();
  });
});
