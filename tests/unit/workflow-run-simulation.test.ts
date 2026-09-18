import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const spies = vi.hoisted(() => ({
  simulateContractCall: vi.fn(),
  simulateCallSequence: vi.fn(),
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

vi.mock("@/lib/execute/simulate-sequence", () => ({
  simulateCallSequence: spies.simulateCallSequence,
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
  spies.simulateCallSequence.mockResolvedValue({
    success: true,
    status: "simulated",
    from: "0xaa0000000000000000000000000000000000aa00",
    atomic: false,
    mechanism: "eth_simulateV1",
    wouldRevert: false,
    results: [SUCCESS_RESULT, SUCCESS_RESULT],
  });
});

const ERC20_APPROVE_ABI = JSON.stringify([
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
]);

function writeNode(
  id: string,
  abiFunction: string,
  config: Record<string, unknown> = {}
): WorkflowSimulationNode {
  return actionNode(
    id,
    "web3/write-contract",
    {
      contractAddress: "0xbb0000000000000000000000000000000000bb00",
      abi: ERC20_APPROVE_ABI,
      abiFunction,
      functionArgs: "[]",
      ...config,
    },
    { label: abiFunction }
  );
}

const REVERT_RESULT = {
  success: false as const,
  status: "simulated" as const,
  from: "0xaa0000000000000000000000000000000000aa00",
  to: "0xbb0000000000000000000000000000000000bb00",
  value: "0",
  failureKind: "revert" as const,
  wouldRevert: true as const,
  revertReason: "ERC4626: deposit more than max",
  error: "ERC4626: deposit more than max",
};

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

  it("skips Solana writes silently without a warning", async () => {
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

    expect(result).toEqual({
      warnings: [],
      simulatedNodeCount: 0,
      skippedNodeCount: 1,
    });
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
    // An uncoded validation failure has no attributed cause to report, so the
    // generic input guidance is still the right answer for it.
    expect(result.warnings[0]?.message).toContain(
      "has invalid transaction inputs"
    );
  });

  it("surfaces an attributed shortfall instead of generic input guidance", async () => {
    // The real underfunded-sender shape: gas estimation rejects the call
    // before the EVM returns revert data, so failureKind stays "validation"
    // while `code` carries the attributed cause.
    spies.simulateNativeTransfer.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: "0xaa0000000000000000000000000000000000aa00",
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "1000000000000000000",
      failureKind: "validation",
      wouldRevert: true,
      revertReason:
        "Insufficient ETH balance. Have: 0.25, Need: 1.0. Fund 0xaa0000000000000000000000000000000000aa00 with at least 0.75 ETH on this chain and retry.",
      error: "Insufficient ETH balance. Have: 0.25, Need: 1.0.",
      code: "insufficient_balance",
      balanceWei: "250000000000000000",
      requiredWei: "1000000000000000000",
      shortfallWei: "750000000000000000",
      nativeSymbol: "ETH",
    });

    const result = await runWorkflowSimulation({
      organizationId: "org_test",
      nodes: [
        actionNode("transfer-1", "web3/transfer-funds", {
          amount: "1",
          recipientAddress: "0xbb0000000000000000000000000000000000bb00",
        }),
      ],
    });

    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_PREFLIGHT_FAILED",
    });
    // The address to fund and the amount to fund it by are the two facts the
    // editor cannot derive on its own, so both have to survive.
    expect(result.warnings[0]?.message).toContain(
      "Fund 0xaa0000000000000000000000000000000000aa00 with at least 0.75 ETH"
    );
    expect(result.warnings[0]?.message).not.toContain(
      "has invalid transaction inputs"
    );
    // The wallet is short; no configured field is wrong. The overlay renders
    // parameterPath under the message and points its Fix button at fieldKey,
    // so naming a field here would send the user to an input that is fine.
    expect(result.warnings[0]?.fieldKey).toBeUndefined();
    expect(result.warnings[0]?.parameterPath).toBe("nodes[0].data.config");
    // Gas estimation rejected the call, so it is not reported as a revert.
    expect(result.warnings[0]?.message).not.toContain("would revert");
  });

  it("softens an attributed shortfall when an earlier step may fund it", async () => {
    spies.simulateNativeTransfer
      .mockResolvedValueOnce(SUCCESS_RESULT)
      .mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        to: "0xcc0000000000000000000000000000000000cc00",
        value: "2000000000000000000",
        failureKind: "validation",
        wouldRevert: true,
        revertReason:
          "Insufficient ETH balance. Have: 0.25, Need: 2.0. Fund 0xaa0000000000000000000000000000000000aa00 with at least 1.75 ETH on this chain and retry.",
        error: "Insufficient ETH balance. Have: 0.25, Need: 2.0.",
        code: "insufficient_balance",
        balanceWei: "250000000000000000",
        requiredWei: "2000000000000000000",
        shortfallWei: "1750000000000000000",
        nativeSymbol: "ETH",
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

    expect(result.warnings[0]).toMatchObject({
      code: "SIMULATION_PREFLIGHT_FAILED",
      nodeId: "write-2",
    });
    expect(result.warnings[0]?.message).toContain(
      "This may depend on an earlier step in this workflow."
    );
    // The shortfall reason already ends in a period, so the appended sentence
    // must not double it.
    expect(result.warnings[0]?.message).not.toContain("retry.. This may");
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

  describe("consecutive writes simulate as one sequence", () => {
    const linear = [
      { source: "trigger-1", target: "approve" },
      { source: "approve", target: "deposit" },
    ];

    it("sends an approve-then-deposit pair to the sequence simulator once", async () => {
      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: linear,
      });

      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(1);
      expect(spies.simulateContractCall).not.toHaveBeenCalled();
      const input = spies.simulateCallSequence.mock.calls[0][0] as {
        network: string;
        calls: { functionName: string }[];
      };
      expect(input.network).toBe("1");
      expect(input.calls.map((c) => c.functionName)).toEqual([
        "approve",
        "deposit",
      ]);
      expect(result).toEqual({
        warnings: [],
        simulatedNodeCount: 2,
        skippedNodeCount: 0,
      });
    });

    it("reports a revert in the second call plainly, without the earlier-step hedge", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        atomic: false,
        mechanism: "eth_simulateV1",
        wouldRevert: true,
        results: [SUCCESS_RESULT, REVERT_RESULT],
      });

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: linear,
      });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({
        code: "SIMULATION_WOULD_REVERT",
        nodeId: "deposit",
        parameterPath: "nodes[2].data.config.abiFunction",
      });
      expect(result.warnings[0]?.message).toBe(
        "deposit would revert: ERC4626: deposit more than max"
      );
      expect(result.warnings[0]?.message).not.toContain("earlier step");
    });

    it("follows the edges, not the array order", async () => {
      // Stored deposit-first; the edges say approve runs first.
      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          writeNode("deposit", "deposit"),
          triggerNode(),
          writeNode("approve", "approve"),
        ],
        edges: linear,
      });

      const input = spies.simulateCallSequence.mock.calls[0][0] as {
        calls: { functionName: string }[];
      };
      expect(input.calls.map((c) => c.functionName)).toEqual([
        "approve",
        "deposit",
      ]);
    });

    it("points a warning at the stored index even when the walk reordered the node", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        atomic: false,
        mechanism: "eth_simulateV1",
        wouldRevert: true,
        results: [SUCCESS_RESULT, REVERT_RESULT],
      });

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          writeNode("deposit", "deposit"),
          triggerNode(),
          writeNode("approve", "approve"),
        ],
        edges: linear,
      });

      expect(result.warnings[0]).toMatchObject({
        nodeId: "deposit",
        parameterPath: "nodes[0].data.config.abiFunction",
      });
    });

    it("chains into the first branch of a fan-out and starts the other branch over", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: true,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        atomic: false,
        mechanism: "eth_simulateV1",
        wouldRevert: false,
        results: [SUCCESS_RESULT, SUCCESS_RESULT],
      });
      spies.simulateContractCall.mockResolvedValueOnce(REVERT_RESULT);

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit-a", "deposit"),
          writeNode("deposit-b", "deposit"),
        ],
        edges: [
          { source: "trigger-1", target: "approve" },
          { source: "approve", target: "deposit-a" },
          { source: "approve", target: "deposit-b" },
        ],
      });

      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(1);
      const input = spies.simulateCallSequence.mock.calls[0][0] as {
        calls: { functionName: string }[];
      };
      expect(input.calls).toHaveLength(2);
      // The second branch did not have the approve applied, so it is
      // simulated on its own and keeps the hedge.
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(1);
      expect(result.warnings[0]).toMatchObject({ nodeId: "deposit-b" });
      expect(result.warnings[0]?.message).toContain(
        "may depend on an earlier step"
      );
    });

    it("chains two-deep branches on both arms of a condition", async () => {
      const nodes = [
        triggerNode(),
        actionNode("cond", "condition"),
        writeNode("x1", "approve"),
        writeNode("x2", "deposit"),
        writeNode("y1", "approve"),
        writeNode("y2", "deposit"),
      ];
      const edges = [
        { source: "trigger-1", target: "cond" },
        { source: "cond", target: "x1" },
        { source: "x1", target: "x2" },
        { source: "cond", target: "y1" },
        { source: "y1", target: "y2" },
      ];

      await runWorkflowSimulation({ organizationId: "org_test", nodes, edges });

      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(2);
      expect(spies.simulateContractCall).not.toHaveBeenCalled();
      const runs = spies.simulateCallSequence.mock.calls.map((call) =>
        (call[0] as { calls: { functionName: string }[] }).calls.map(
          (c) => c.functionName
        )
      );
      expect(runs).toEqual([
        ["approve", "deposit"],
        ["approve", "deposit"],
      ]);
    });

    it("keeps chaining when a write also feeds a non-write node", async () => {
      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          actionNode("notify", "discord/send-message"),
          writeNode("deposit", "deposit"),
        ],
        edges: [
          { source: "trigger-1", target: "approve" },
          { source: "approve", target: "notify" },
          { source: "approve", target: "deposit" },
        ],
      });

      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(1);
      expect(spies.simulateContractCall).not.toHaveBeenCalled();
    });

    it("keeps the hedge on a run that starts after an earlier reachable write", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        atomic: false,
        mechanism: "eth_simulateV1",
        wouldRevert: true,
        results: [SUCCESS_RESULT, REVERT_RESULT],
      });

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          actionNode("fund", "web3/transfer-token", {
            amount: "5",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
            tokenAddress: "0xcc0000000000000000000000000000000000cc00",
          }),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: [
          { source: "trigger-1", target: "fund" },
          { source: "fund", target: "approve" },
          { source: "approve", target: "deposit" },
        ],
      });

      // The token transfer that funds the deposit was not applied by the
      // sequence, so the deposit's revert is still hedged.
      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(1);
      expect(result.warnings[0]).toMatchObject({ nodeId: "deposit" });
      expect(result.warnings[0]?.message).toContain(
        "may depend on an earlier step"
      );
    });

    it("keeps a write that carries native value on the single-call path", async () => {
      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("wrap", "deposit", { ethValue: "0.1" }),
          writeNode("approve", "approve"),
        ],
        edges: [
          { source: "trigger-1", target: "wrap" },
          { source: "wrap", target: "approve" },
        ],
      });

      expect(spies.simulateCallSequence).not.toHaveBeenCalled();
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(2);
    });

    it("ignores an edge to a node that no longer exists", async () => {
      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: [...linear, { source: "approve", target: "deleted-node" }],
      });

      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(1);
      expect(spies.simulateContractCall).not.toHaveBeenCalled();
    });

    it("ends a run when the chain changes", async () => {
      spies.getChainIdFromNetwork.mockImplementation((network: string) =>
        Number(network)
      );

      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve", { network: "1" }),
          writeNode("deposit", "deposit", { network: "8453" }),
        ],
        edges: linear,
      });

      expect(spies.simulateCallSequence).not.toHaveBeenCalled();
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(2);
    });

    it("ends a run at a template-bound node and resumes after it", async () => {
      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("middle", "deposit", {
            functionArgs: '["{{@trigger-1:Trigger.amount}}"]',
          }),
          writeNode("last", "withdraw"),
        ],
        edges: [
          { source: "trigger-1", target: "approve" },
          { source: "approve", target: "middle" },
          { source: "middle", target: "last" },
        ],
      });

      expect(spies.simulateCallSequence).not.toHaveBeenCalled();
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(2);
      expect(result.warnings.map((w) => [w.code, w.nodeId])).toEqual([
        ["SIMULATION_DYNAMIC_INPUT", "middle"],
      ]);
    });

    it("does not chain a transfer into a write", async () => {
      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          actionNode("send", "web3/transfer-funds", {
            amount: "1",
            recipientAddress: "0xbb0000000000000000000000000000000000bb00",
          }),
          writeNode("deposit", "deposit"),
        ],
        edges: [
          { source: "trigger-1", target: "send" },
          { source: "send", target: "deposit" },
        ],
      });

      expect(spies.simulateCallSequence).not.toHaveBeenCalled();
      expect(spies.simulateNativeTransfer).toHaveBeenCalledTimes(1);
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(1);
    });

    it("falls back to per-node simulation when the sequence cannot answer", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "",
        atomic: false,
        mechanism: null,
        wouldRevert: false,
        error: "Simulation unavailable: node down",
        results: [],
      });

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: linear,
      });

      // Each node keeps the per-node result it would have had on its own.
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        warnings: [],
        simulatedNodeCount: 2,
        skippedNodeCount: 0,
      });
    });

    it("keeps the earlier-step hedge on a per-node fallback", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "",
        atomic: false,
        mechanism: null,
        wouldRevert: false,
        error: "No RPC configuration for chain ID 1",
        results: [],
      });
      spies.simulateContractCall
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockResolvedValueOnce(REVERT_RESULT);

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: linear,
      });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.message).toContain(
        "may depend on an earlier step"
      );
    });

    it("simulates a call the sequence could not run on its own", async () => {
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: false,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        atomic: false,
        mechanism: "eth_simulateV1",
        wouldRevert: false,
        results: [
          SUCCESS_RESULT,
          {
            ...SUCCESS_RESULT,
            success: false,
            failureKind: "unavailable",
            wouldRevert: false,
            error: "the node returned no result for this call",
          },
        ],
      });

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [
          triggerNode(),
          writeNode("approve", "approve"),
          writeNode("deposit", "deposit"),
        ],
        edges: linear,
      });

      expect(spies.simulateContractCall).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        warnings: [],
        simulatedNodeCount: 2,
        skippedNodeCount: 0,
      });
    });

    it("caps a run at the sequence limit and starts a new run after it", async () => {
      const ids = Array.from({ length: 11 }, (_, i) => `write-${i + 1}`);
      const edges = ids.map((id, i) => ({
        source: i === 0 ? "trigger-1" : ids[i - 1],
        target: id,
      }));
      spies.simulateCallSequence.mockResolvedValueOnce({
        success: true,
        status: "simulated",
        from: "0xaa0000000000000000000000000000000000aa00",
        atomic: false,
        mechanism: "eth_simulateV1",
        wouldRevert: false,
        results: Array.from({ length: 10 }, () => SUCCESS_RESULT),
      });
      spies.simulateContractCall.mockResolvedValueOnce(REVERT_RESULT);

      const result = await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [triggerNode(), ...ids.map((id) => writeNode(id, "approve"))],
        edges,
      });

      expect(spies.simulateCallSequence).toHaveBeenCalledTimes(1);
      const input = spies.simulateCallSequence.mock.calls[0][0] as {
        calls: unknown[];
      };
      expect(input.calls).toHaveLength(10);
      // The eleventh is a run of one, simulated on its own, and it keeps the
      // hedge: not all of its earlier steps were applied.
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(1);
      expect(result.simulatedNodeCount).toBe(10);
      expect(result.skippedNodeCount).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.nodeId).toBe("write-11");
      expect(result.warnings[0]?.message).toContain(
        "may depend on an earlier step"
      );
    });

    it("keeps a single write on the single-call path", async () => {
      await runWorkflowSimulation({
        organizationId: "org_test",
        nodes: [triggerNode(), writeNode("approve", "approve")],
        edges: [{ source: "trigger-1", target: "approve" }],
      });

      expect(spies.simulateCallSequence).not.toHaveBeenCalled();
      expect(spies.simulateContractCall).toHaveBeenCalledTimes(1);
    });
  });
});
