import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const { mockDbWhere } = vi.hoisted(() => ({ mockDbWhere: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          mockDbWhere(...args);
          return Promise.resolve([{ workflowId: "wf-1" }]);
        },
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId", workflowId: "workflowId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  sql: () => ({}),
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  resolveFailOnError: (failOnError: unknown) =>
    failOnError !== false && failOnError !== "false",
}));

vi.mock("@/lib/utils/id", () => ({
  generateId: () => "test-unique-id",
}));

vi.mock("@/lib/rpc/scrub-rpc-urls", () => ({
  redactAllUrls: (text: string) => text,
}));

const mockGetChainIdFromNetwork = vi.fn();
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

const mockGetRpcProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

const mockRpcRelayErrorClass = vi.fn();
vi.mock("@/lib/rpc/providers", () => ({
  rpcRelayErrorClass: (...args: unknown[]) => mockRpcRelayErrorClass(...args),
}));

vi.mock("@/lib/contracts/multicall3", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  MULTICALL3_ABI: [
    { name: "aggregate3", type: "function", inputs: [], outputs: [] },
  ],
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: "user-1",
  }),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
  initializeWalletSigner: vi.fn().mockResolvedValue({
    getAddress: vi
      .fn()
      .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
  }),
}));

const mockResolveSignerForNode = vi.fn();
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: (...args: unknown[]) =>
    mockResolveSignerForNode(...args),
}));

const { mockExecuteContractCall } = vi.hoisted(() => ({
  mockExecuteContractCall: vi.fn(),
}));
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn().mockReturnValue({
    executeContractCall: mockExecuteContractCall,
    getTransactionUrl: vi
      .fn()
      .mockResolvedValue("https://etherscan.io/tx/0xhash"),
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/decode-revert-error")>();
  return {
    ...actual,
    classifyRevert: vi.fn().mockReturnValue({ kind: "unknown" }),
    formatContractError: vi.fn((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    ),
    // decodeRevertReason is kept real: decodeAggregate3Entry's fallback
    // chain (own ABI -> common OZ selectors -> string revert) is exactly
    // what's under test in the "decoded results" describe block below.
  };
});

const mockResolveGasLimitOverrides = vi.fn();
const mockParsePriorityFeeGwei = vi.fn();
vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: (...args: unknown[]) =>
    mockResolveGasLimitOverrides(...args),
  parsePriorityFeeGwei: (...args: unknown[]) =>
    mockParsePriorityFeeGwei(...args),
}));

const mockPreflightGasBalance = vi.fn();
vi.mock("@/lib/web3/gas-preflight", () => ({
  preflightGasBalance: (...args: unknown[]) => mockPreflightGasBalance(...args),
  resolveFundingHolder: (_signerMode: unknown, walletAddress: string) =>
    walletAddress,
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: (
    _txContext: unknown,
    _walletAddress: unknown,
    fn: (session: unknown) => unknown
  ) => fn({ walletAddress: "0xwalletaddress", chainId: 1 }),
}));

const mockStaticCall = vi.fn();
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class MockProvider {},
      Contract: class MockContract {
        aggregate3 = { staticCall: mockStaticCall };
      },
    },
  };
});

import { ethers } from "ethers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  OnChainPendingError,
  OnChainRevertError,
} from "@/lib/web3/onchain-revert";
import {
  applyBatchFailOnError,
  type BatchWriteContractCoreInput,
  batchWriteContractCore,
} from "@/plugins/web3/steps/batch-write-contract-core";

const WORK_ABI = JSON.stringify([
  {
    type: "function",
    name: "work",
    stateMutability: "nonpayable",
    inputs: [
      { name: "network", type: "bytes32" },
      { name: "args", type: "bytes" },
    ],
    outputs: [],
  },
]);

const APPROVE_ABI = JSON.stringify([
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

const JOB_1 = "0x1111111111111111111111111111111111111111";
const JOB_2 = "0x2222222222222222222222222222222222222222";
const NETWORK_BYTES32 = `0x${"11".repeat(32)}`;
const ARGS_BYTES = "0xabcd1234";

type CallOverrides = Partial<{
  abi: string;
  abiFunction: string;
  args: unknown[];
}>;

function makeCall(contractAddress: string, overrides: CallOverrides = {}) {
  return {
    contractAddress,
    abi: overrides.abi ?? WORK_ABI,
    abiFunction: overrides.abiFunction ?? "work",
    args: overrides.args ?? [NETWORK_BYTES32, ARGS_BYTES],
  };
}

function baseInput(
  overrides: Partial<BatchWriteContractCoreInput>
): BatchWriteContractCoreInput {
  return {
    network: "1",
    calls: JSON.stringify([makeCall(JOB_1), makeCall(JOB_2)]),
    _context: { organizationId: "org-1" },
    ...overrides,
  };
}

const RECEIPT = {
  hash: "0xhash",
  gasUsed: BigInt(100_000),
  effectiveGasPrice: BigInt(1_000_000_000),
};

const SUCCESS_RETURN: [boolean, string] = [true, "0x"];

function revertReturn(): [boolean, string] {
  return [false, "0x"];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChainIdFromNetwork.mockReturnValue(1);
  mockGetRpcProvider.mockResolvedValue({
    resolveActiveRpcUrl: () => Promise.resolve("https://rpc.example.com"),
    executeWithFailover: (fn: (provider: unknown) => unknown) => fn({}),
  });
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xwalletaddress",
  });
  mockResolveGasLimitOverrides.mockReturnValue({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  });
  mockParsePriorityFeeGwei.mockReturnValue(undefined);
  mockExecuteContractCall.mockResolvedValue(RECEIPT);
  mockPreflightGasBalance.mockResolvedValue({ affordable: true });
});

describe("batch-write-contract - happy path", () => {
  it("broadcasts one atomic transaction for N calls, all succeed", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.transactionHash).toBe("0xhash");
    expect(result.chainId).toBe(1);
    expect(result.transactionLink).toBe("https://etherscan.io/tx/0xhash");
    expect(result.totalCalls).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results?.[0].success).toBe(true);
    expect(result.results?.[1].success).toBe(true);

    expect(mockExecuteContractCall).toHaveBeenCalledTimes(1);
    const call3Arg = mockExecuteContractCall.mock.calls[0][1] as {
      args: [{ target: string; allowFailure: boolean; callData: string }[]];
    };
    expect(call3Arg.args[0]).toHaveLength(2);
    expect(call3Arg.args[0][0].target).toBe(JOB_1);
    expect(call3Arg.args[0][0].allowFailure).toBe(true);
    expect(call3Arg.args[0][1].target).toBe(JOB_2);
  });

  it("runs the pre-broadcast simulation from the organization wallet, not the zero-address default", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    await batchWriteContractCore(baseInput({}));

    expect(mockStaticCall).toHaveBeenCalledTimes(1);
    const simulationOverrides = mockStaticCall.mock.calls[0][1] as {
      from: string;
    };
    expect(simulationOverrides.from).toBe(
      "0xwalletaddress1234567890123456789012345678"
    );
  });

  it("broadcasts one atomic transaction for calls to different contracts with different ABIs/functions", async () => {
    const approveIface = new ethers.Interface(JSON.parse(APPROVE_ABI));
    const approveReturnData = approveIface.encodeFunctionResult("approve", [
      true,
    ]);
    mockStaticCall.mockResolvedValueOnce([
      SUCCESS_RETURN,
      [true, approveReturnData],
    ]);

    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          makeCall(JOB_1),
          makeCall(JOB_2, {
            abi: APPROVE_ABI,
            abiFunction: "approve",
            args: [JOB_1, "1000"],
          }),
        ]),
      })
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.totalCalls).toBe(2);
    expect(result.results?.[0].success).toBe(true);
    expect(result.results?.[1].success).toBe(true);
    expect(result.results?.[1].result).toBe(true);
  });
});

describe("batch-write-contract - per-call failure isolation", () => {
  it("isolateCallFailures true: one call fails, batch still broadcasts", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, revertReturn()]);

    const result = await batchWriteContractCore(
      baseInput({ isolateCallFailures: "true" })
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.results?.[0].success).toBe(true);
    expect(result.results?.[1].success).toBe(false);
    expect(result.results?.[1].error).toContain("reverted");

    const call3Arg = mockExecuteContractCall.mock.calls[0][1] as {
      args: [{ allowFailure: boolean }[]];
    };
    expect(call3Arg.args[0][0].allowFailure).toBe(true);
    expect(call3Arg.args[0][1].allowFailure).toBe(true);
  });

  it("isolateCallFailures false: encodes allowFailure=false for every call", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    await batchWriteContractCore(baseInput({ isolateCallFailures: "false" }));

    const call3Arg = mockExecuteContractCall.mock.calls[0][1] as {
      args: [{ allowFailure: boolean }[]];
    };
    expect(call3Arg.args[0][0].allowFailure).toBe(false);
    expect(call3Arg.args[0][1].allowFailure).toBe(false);
  });

  it("isolateCallFailures as the native boolean false: encodes allowFailure=false too, not just the string", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    await batchWriteContractCore(baseInput({ isolateCallFailures: false }));

    const call3Arg = mockExecuteContractCall.mock.calls[0][1] as {
      args: [{ allowFailure: boolean }[]];
    };
    expect(call3Arg.args[0][0].allowFailure).toBe(false);
    expect(call3Arg.args[0][1].allowFailure).toBe(false);
  });

  it("still applies the shared isolateCallFailures toggle to every call even with different ABIs", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    await batchWriteContractCore(
      baseInput({
        isolateCallFailures: "false",
        calls: JSON.stringify([
          makeCall(JOB_1),
          makeCall(JOB_2, {
            abi: APPROVE_ABI,
            abiFunction: "approve",
            args: [JOB_1, "1000"],
          }),
        ]),
      })
    );

    const call3Array = mockStaticCall.mock.calls[0][0] as {
      allowFailure: boolean;
    }[];
    expect(call3Array.every((c) => c.allowFailure === false)).toBe(true);
  });

  it("whole batch revert: pre-broadcast staticCall itself rejects, no errorClass so softenable", async () => {
    mockStaticCall.mockRejectedValueOnce(new Error("execution reverted"));

    const result = await batchWriteContractCore(
      baseInput({ isolateCallFailures: "false" })
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.errorClass).toBeUndefined();
    expect(mockExecuteContractCall).not.toHaveBeenCalled();

    const softened = applyBatchFailOnError(result, false);
    expect(softened.success).toBe(true);
    if (!softened.success) {
      throw new Error("expected softened success");
    }
    expect(softened.error).toContain("execution reverted");
    expect(softened.results).toBeUndefined();
    expect(softened.transactionHash).toBeUndefined();
  });

  it("all calls fail simulation: aborts before broadcasting", async () => {
    mockStaticCall.mockResolvedValueOnce([revertReturn(), revertReturn()]);

    const result = await batchWriteContractCore(
      baseInput({ isolateCallFailures: "true" })
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.error).toContain("All 2 calls failed simulation");
    expect(result.errorClass).toBeUndefined();
    expect(result.results).toHaveLength(2);
    expect(result.totalCalls).toBe(2);
    expect(mockExecuteContractCall).not.toHaveBeenCalled();
  });

  it("simulation result count mismatch: fails structured instead of throwing on index out of bounds", async () => {
    mockStaticCall.mockResolvedValueOnce([
      SUCCESS_RETURN,
      SUCCESS_RETURN,
      SUCCESS_RETURN,
    ]);

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.error).toBe("Simulation returned 3 results for 2 calls");
    expect(result.errorClass).toBe(ExecutionErrorType.EXTERNAL);
    expect(result.results).toBeUndefined();
    expect(result.totalCalls).toBeUndefined();
    expect(mockExecuteContractCall).not.toHaveBeenCalled();
  });

  it("broadcasts when aggregate3 reports success but declared outputs don't decode against the actual return data", async () => {
    const boolReturnAbi = JSON.stringify([
      {
        type: "function",
        name: "work",
        stateMutability: "nonpayable",
        inputs: [
          { name: "network", type: "bytes32" },
          { name: "args", type: "bytes" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ]);
    // Raw aggregate3 flag is true on both entries (on-chain success), but the
    // empty "0x" return data won't decode against a declared `returns (bool)`,
    // so decodeAggregate3Entry reports success:false for both. The abort must
    // key on the raw flag, not this decoded one, or it wrongly skips a batch
    // that actually succeeded on-chain.
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          makeCall(JOB_1, { abi: boolReturnAbi }),
          makeCall(JOB_2, { abi: boolReturnAbi }),
        ]),
        isolateCallFailures: "true",
      })
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.transactionHash).toBe("0xhash");
    expect(result.results).toHaveLength(2);
    expect(result.results?.[0].success).toBe(false);
    expect(result.results?.[1].success).toBe(false);
    expect(mockExecuteContractCall).toHaveBeenCalledTimes(1);
  });

  it("preserves results/totalCalls when softening an all-calls-failed abort", async () => {
    mockStaticCall.mockResolvedValueOnce([revertReturn(), revertReturn()]);

    const result = await batchWriteContractCore(
      baseInput({ isolateCallFailures: "true" })
    );
    expect(result.success).toBe(false);

    const softened = applyBatchFailOnError(result, false);
    expect(softened.success).toBe(true);
    if (!softened.success) {
      throw new Error("expected softened success");
    }
    expect(softened.results).toHaveLength(2);
    expect(softened.totalCalls).toBe(2);
  });
});

describe("batch-write-contract - EOA-only gate", () => {
  it("rejects SAFE signer mode before any RPC/broadcast work", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe",
      safeAddress: "0xsafe",
    });

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.errorClass).toBe(ExecutionErrorType.USER);
    expect(result.error).toContain("EOA");
    expect(mockStaticCall).not.toHaveBeenCalled();
    expect(mockExecuteContractCall).not.toHaveBeenCalled();
  });

  it("rejects SAFE_ROLE signer mode before any RPC/broadcast work", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe-role",
      safeAddress: "0xsafe",
    });

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.errorClass).toBe(ExecutionErrorType.USER);
    expect(mockStaticCall).not.toHaveBeenCalled();
    expect(mockExecuteContractCall).not.toHaveBeenCalled();
  });
});

describe("batch-write-contract - gas preflight", () => {
  it("rejects before acquiring the nonce lock when the org wallet cannot afford gas", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockPreflightGasBalance.mockResolvedValueOnce({
      affordable: false,
      message: "Insufficient MATIC balance to cover gas on Polygon",
    });

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.error).toBe(
      "Insufficient MATIC balance to cover gas on Polygon"
    );
    // Runs after the free pre-broadcast simulation, but must reject before
    // the nonce lock/broadcast: a wallet that can't pay must not take the
    // lock, run a full RPC failover round, and only fail at send, stalling
    // every other execution queued behind the same wallet.
    expect(mockStaticCall).toHaveBeenCalled();
    expect(mockExecuteContractCall).not.toHaveBeenCalled();
  });

  it("broadcasts normally when the org wallet can afford gas", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockPreflightGasBalance.mockResolvedValueOnce({ affordable: true });

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(true);
    expect(mockExecuteContractCall).toHaveBeenCalledOnce();
  });
});

describe("batch-write-contract - MAX_TOTAL_CALLS", () => {
  it("rejects a batch of 201 calls", async () => {
    const calls = Array.from({ length: 201 }, () => makeCall(JOB_1));

    const result = await batchWriteContractCore(
      baseInput({ calls: JSON.stringify(calls) })
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.error).toContain("Too many calls");
    expect(result.errorClass).toBe(ExecutionErrorType.USER);
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("accepts a batch of exactly 200 calls", async () => {
    mockStaticCall.mockResolvedValueOnce(
      Array.from({ length: 200 }, () => SUCCESS_RETURN)
    );
    const calls = Array.from({ length: 200 }, () => makeCall(JOB_1));

    const result = await batchWriteContractCore(
      baseInput({ calls: JSON.stringify(calls) })
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.totalCalls).toBe(200);
  });
});

describe("batch-write-contract - native array calls input", () => {
  it("accepts calls as a native array, not just a JSON string", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    const result = await batchWriteContractCore(
      baseInput({ calls: [makeCall(JOB_1), makeCall(JOB_2)] })
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.totalCalls).toBe(2);
  });
});

describe("batch-write-contract - malformed calls JSON", () => {
  it("fails on non-JSON calls", async () => {
    const result = await batchWriteContractCore(
      baseInput({ calls: "not json" })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid Calls JSON");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("fails when calls is not an array", async () => {
    const result = await batchWriteContractCore(
      baseInput({ calls: '{"not":"array"}' })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Calls must be a JSON array");
    }
  });

  it("fails on an empty calls array", async () => {
    const result = await batchWriteContractCore(baseInput({ calls: "[]" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("at least one entry");
    }
  });

  it("fails when an entry is not an object", async () => {
    const result = await batchWriteContractCore(
      baseInput({ calls: '["not-an-object"]' })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("index 0");
      expect(result.error).toContain("must be an object");
    }
  });

  it("fails when contractAddress is missing", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          { abi: WORK_ABI, abiFunction: "work", args: [] },
        ]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("missing contractAddress");
    }
  });

  it("fails when contractAddress is invalid", async () => {
    const result = await batchWriteContractCore(
      baseInput({ calls: JSON.stringify([makeCall("not-an-address")]) })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("invalid address");
    }
  });

  it("fails when a call entry is missing abi", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          { contractAddress: JOB_1, abiFunction: "work", args: [] },
        ]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("missing abi");
    }
  });

  it("fails when a call entry is missing abiFunction", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          { contractAddress: JOB_1, abi: WORK_ABI, args: [] },
        ]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("missing abiFunction");
    }
  });

  it("fails when args is present but not an array", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          makeCall(JOB_1, { args: "not-an-array" as unknown as unknown[] }),
        ]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("args must be an array");
    }
  });
});

describe("batch-write-contract - per-call ABI/function validation", () => {
  it("fails when a call's ABI is invalid JSON", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([makeCall(JOB_1, { abi: "not json" })]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("index 0");
      expect(result.error).toContain("Invalid ABI JSON");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("fails when a call's ABI is not an array", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([makeCall(JOB_1, { abi: '{"not":"array"}' })]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ABI must be a JSON array");
    }
  });

  it("fails per-call when the function is not found in that call's own ABI", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          makeCall(JOB_1, { abiFunction: "doesNotExist" }),
        ]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("index 0");
      expect(result.error).toContain("not found in ABI");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("reports the correct index when the second call is invalid", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([
          makeCall(JOB_1),
          makeCall(JOB_2, {
            abi: APPROVE_ABI,
            abiFunction: "approve",
            args: ["not-an-address", "1000"],
          }),
        ]),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("index 1");
    }
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });
});

describe("batch-write-contract - per-call argument validation", () => {
  it("fails when a call's args do not match its function's arity", async () => {
    const result = await batchWriteContractCore(
      baseInput({
        calls: JSON.stringify([makeCall(JOB_1), makeCall(JOB_2, { args: [] })]),
      })
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("index 1");
    }
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });
});

describe("batch-write-contract - failOnError softening", () => {
  it("does not soften a hard EOA-gate failure regardless of failOnError", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe",
      safeAddress: "0xsafe",
    });

    const hardFailure = await batchWriteContractCore(baseInput({}));
    expect(hardFailure.success).toBe(false);

    // EOA-gate failures carry errorClass (USER), so they are not softenable
    // regardless of failOnError. Confirms the gate is a hard boundary.
    const notSoftened = applyBatchFailOnError(hardFailure, false);
    expect(notSoftened).toBe(hardFailure);
  });

  it("softens a genuine broadcast failure only when failOnError is false", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockExecuteContractCall.mockRejectedValueOnce(new Error("nonce too low"));

    const result = await batchWriteContractCore(baseInput({}));
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.errorClass).toBeUndefined();

    const kept = applyBatchFailOnError(result, true);
    expect(kept.success).toBe(false);

    const softened = applyBatchFailOnError(result, false);
    expect(softened.success).toBe(true);
    if (!softened.success) {
      throw new Error("expected softened success");
    }
    expect(softened.error).toContain("nonce too low");
    // A plain broadcast-time Error isn't a confirmed on-chain revert: the
    // transaction may never have been submitted, or may have been submitted
    // and its confirmation lost to a timeout, so the per-call outcome is
    // genuinely unknown. results/totalCalls must be omitted rather than
    // asserting success:false, which would falsely claim certainty.
    expect(softened.results).toBeUndefined();
    expect(softened.totalCalls).toBeUndefined();
    expect(softened.transactionHash).toBeUndefined();
  });

  it("reports every call as failed, with the reverted transaction hash, on a confirmed on-chain revert", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockExecuteContractCall.mockRejectedValueOnce(
      new OnChainRevertError({
        message:
          "Transaction 0xdeadbeef reverted on-chain (status 0, block 100)",
        transactionHash: "0xdeadbeef",
        blockNumber: 100,
      })
    );

    const result = await batchWriteContractCore(baseInput({}));
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.transactionHash).toBe("0xdeadbeef");
    // aggregate3 is atomic: a confirmed revert means neither call took
    // effect, so unlike the unknown-outcome case above, results can safely
    // assert success:false for each.
    expect(result.results).toHaveLength(2);
    for (const call of result.results ?? []) {
      expect(call.success).toBe(false);
      expect(call.error).toContain("Reverted on-chain");
    }
    expect(result.totalCalls).toBe(2);
  });

  it("tags a broadcast failure caused by an RPC relay transport error as EXTERNAL, and still softens it", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockExecuteContractCall.mockRejectedValueOnce(
      new Error("relay unreachable")
    );
    mockRpcRelayErrorClass.mockReturnValueOnce(ExecutionErrorType.EXTERNAL);

    const result = await batchWriteContractCore(baseInput({}));
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.errorClass).toBe(ExecutionErrorType.EXTERNAL);

    // EXTERNAL failures are still softenable, same as an untagged failure --
    // only USER/SYSTEM-classified failures are a hard boundary. This is what
    // keeps failOnError=false skipping past a private-relay hiccup instead of
    // aborting the workflow, matching write-contract-core's own carve-out.
    const softened = applyBatchFailOnError(result, false);
    expect(softened.success).toBe(true);
  });

  it("refuses to soften a broadcast whose receipt could not be read", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockExecuteContractCall.mockRejectedValueOnce(
      new OnChainPendingError({
        message: "Transaction sent but receipt not available",
        transactionHash: "0xpending",
      })
    );

    const result = await batchWriteContractCore(baseInput({}));
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure");
    }
    expect(result.transactionHash).toBe("0xpending");
    expect(result.errorClass).toBe(ExecutionErrorType.SYSTEM);
    // Unlike the confirmed revert above, nothing about the sub-calls is known:
    // the batch may still mine, so it must not report them as reverted.
    expect(result.results).toBeUndefined();
    expect(result.totalCalls).toBeUndefined();

    // This local copy of the softening rule is a second implementation of the
    // same carve-out, so it needs its own guard: without the SYSTEM class it
    // would continue the workflow as though the batch never happened while
    // the transaction is still in flight.
    const softened = applyBatchFailOnError(result, false);
    expect(softened.success).toBe(false);
    expect(softened).toBe(result);
  });
});

describe("batch-write-contract - gas overrides threaded through", () => {
  it("forwards resolved gas overrides and priority fee to executeContractCall", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);
    mockResolveGasLimitOverrides.mockReturnValue({
      multiplierOverride: 1.5,
      gasLimitOverride: undefined,
    });
    const fiveGweiWei = BigInt(5e9);
    mockParsePriorityFeeGwei.mockReturnValue(fiveGweiWei);

    await batchWriteContractCore(
      baseInput({ gasLimitMultiplier: "1.5", priorityFeeGwei: "5" })
    );

    expect(mockResolveGasLimitOverrides).toHaveBeenCalledWith("1.5");
    expect(mockParsePriorityFeeGwei).toHaveBeenCalledWith("5");
    expect(mockExecuteContractCall).toHaveBeenCalledTimes(1);
    const optionsArg = mockExecuteContractCall.mock.calls[0][3] as {
      gasOverrides: {
        multiplierOverride?: number;
        gasLimitOverride?: bigint;
        priorityFeeOverride?: bigint;
      };
    };
    expect(optionsArg.gasOverrides.multiplierOverride).toBe(1.5);
    expect(optionsArg.gasOverrides.priorityFeeOverride).toBe(fiveGweiWei);
  });
});

describe("batch-write-contract - decoded results", () => {
  it("decodes a real revert reason from returnData", async () => {
    const errorData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["Splitter/kicked-too-soon"]
    );
    const revertData = `0x08c379a0${errorData.slice(2)}`;
    mockStaticCall.mockResolvedValueOnce([[false, revertData], SUCCESS_RETURN]);

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.results?.[0].success).toBe(false);
    expect(result.results?.[0].error).toContain("Splitter/kicked-too-soon");
    expect(result.results?.[1].success).toBe(true);
  });

  it("decodes a common OZ custom error not declared in that call's own ABI", async () => {
    // OwnableUnauthorizedAccount is a real OpenZeppelin error, but WORK_ABI
    // (this call's declared ABI) doesn't include it. Without the
    // common-error-selector fallback, this would just say "Call reverted".
    const commonErrorsIface = new ethers.Interface([
      "error OwnableUnauthorizedAccount(address account)",
    ]);
    const revertData = commonErrorsIface.encodeErrorResult(
      "OwnableUnauthorizedAccount",
      [JOB_1]
    );
    mockStaticCall.mockResolvedValueOnce([[false, revertData], SUCCESS_RETURN]);

    const result = await batchWriteContractCore(baseInput({}));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.results?.[0].success).toBe(false);
    expect(result.results?.[0].error).toContain("OwnableUnauthorizedAccount");
    expect(result.results?.[1].success).toBe(true);
  });
});

describe("batch-write-contract - workflowId resolution", () => {
  it("does not query the DB when _context.workflowId is already present", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    const result = await batchWriteContractCore(
      baseInput({
        _context: { organizationId: "org-1", workflowId: "wf-present" },
      })
    );

    expect(result.success).toBe(true);
    expect(mockDbWhere).not.toHaveBeenCalled();
  });

  it("does not query the DB for a direct execution (organizationId present, no workflowId)", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    const result = await batchWriteContractCore(
      baseInput({
        _context: { organizationId: "org-1", executionId: "exec-1" },
      })
    );

    expect(result.success).toBe(true);
    expect(mockDbWhere).not.toHaveBeenCalled();
  });

  it("falls back to a DB lookup when executionId is present without organizationId or workflowId", async () => {
    mockStaticCall.mockResolvedValueOnce([SUCCESS_RETURN, SUCCESS_RETURN]);

    const result = await batchWriteContractCore(
      baseInput({ _context: { executionId: "exec-1" } })
    );

    expect(result.success).toBe(true);
    expect(mockDbWhere).toHaveBeenCalledTimes(1);
  });
});
