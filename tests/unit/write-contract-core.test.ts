import { beforeEach, describe, expect, it, vi } from "vitest";

const DIRECT_ID_PREFIX_REGEX = /^direct-/;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
    TRANSACTION: "transaction",
  },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId", workflowId: "workflowId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  // KEEP-966: lib/db/schema-extensions.ts's new directExecutions.receipts
  // column default (sql`'[]'::jsonb`) is evaluated at module-import time, so
  // this transitively-loaded mock needs a stand-in tagged-template function.
  sql: () => ({}),
}));

// Mock generateId as a spy returning a deterministic test value
const mockGenerateId = vi.fn().mockReturnValue("test-unique-id");
vi.mock("@/lib/utils/id", () => ({
  generateId: () => mockGenerateId(),
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn().mockReturnValue(1),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockResolvedValue({
    resolveActiveRpcUrl: vi.fn().mockResolvedValue("https://rpc.example.com"),
  }),
}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn().mockReturnValue(true),
    Interface: vi.fn().mockImplementation(() => ({})),
    Contract: vi.fn().mockImplementation(() => ({})),
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    parseEther: vi.fn().mockReturnValue(BigInt(0)),
  },
}));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: vi.fn().mockReturnValue("https://etherscan.io/address/0x1234"),
  getTxUrl: vi.fn().mockReturnValue("https://etherscan.io/tx/0xhash"),
}));

vi.mock("@/lib/abi/struct-args", () => ({
  reshapeArgsForAbi: vi.fn().mockImplementation((args: unknown[]) => args),
}));

vi.mock("@/lib/abi/function-key", () => ({
  getAbiFunctionKey: vi.fn().mockReturnValue("transfer"),
}));

// Spy on executeContractCall so tests can inspect the gasOverrides arg.
// Hoisted so the mock factory below sees an initialized value at module load.
const { mockExecuteContractCall } = vi.hoisted(() => ({
  mockExecuteContractCall: vi.fn().mockResolvedValue({
    hash: "0xhash",
    gasUsed: BigInt(21_000),
    effectiveGasPrice: BigInt(1_000_000_000),
  }),
}));
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn().mockReturnValue({
    executeContractCall: mockExecuteContractCall,
    getTransactionUrl: vi
      .fn()
      .mockResolvedValue("https://etherscan.io/tx/0xhash"),
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  formatContractError: vi.fn().mockReturnValue("contract error"),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: vi.fn().mockReturnValue({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
  parsePriorityFeeGwei: vi.fn().mockReturnValue(undefined),
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

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerMode: vi.fn().mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xwalletaddress",
  }),
  resolveSignerForNode: vi.fn().mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xwalletaddress",
  }),
}));

vi.mock("@/lib/safe/execute-as-safe", () => ({
  executeContractCallAsSafe: vi.fn(),
  executeNativeTransferAsSafe: vi.fn(),
}));

const mockTraceExecutedCall = vi.fn();
vi.mock("@/lib/web3/trace-executed-call", () => ({
  traceExecutedCallWithFailover: (...args: unknown[]) =>
    mockTraceExecutedCall(...args),
}));

// Capture txContext passed to withNonceSession
let capturedTxContext: Record<string, unknown> | null = null;
vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: vi.fn(
    (
      txContext: Record<string, unknown>,
      _walletAddress: unknown,
      fn: (session: unknown) => unknown
    ) => {
      capturedTxContext = txContext;
      return fn({
        walletAddress: "0xwalletaddress",
        chainId: 1,
        executionId: txContext.executionId,
        currentNonce: 5,
        startedAt: new Date(),
      });
    }
  ),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { parsePriorityFeeGwei } from "@/lib/web3/gas-defaults";
// Import mocks for assertion
import { initializeWalletSigner } from "@/lib/web3/wallet-helpers";

// Import SUT after all mocks
import { writeContractCore } from "@/plugins/web3/steps/write-contract-core";

const VALID_ABI = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

const MOCK_EXECUTED_CALL = {
  contractAddress: "0x1234567890123456789012345678901234567890",
  functionName: "transfer",
  functionSignature: "transfer(address,uint256)",
  args: { to: "0xrecipient", amount: "1000" },
  sponsored: false,
  topLevelTo: "0x1234567890123456789012345678901234567890",
  reverted: false,
};

describe("writeContractCore executedCall on direct send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
    mockTraceExecutedCall.mockResolvedValue(undefined);
  });

  it("attaches executedCall when trace succeeds", async () => {
    mockTraceExecutedCall.mockResolvedValue(MOCK_EXECUTED_CALL);

    const result = await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.executedCall).toEqual(MOCK_EXECUTED_CALL);
    }
  });

  it("omits executedCall when trace returns undefined (graceful degradation)", async () => {
    mockTraceExecutedCall.mockResolvedValue(undefined);

    const result = await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.executedCall).toBeUndefined();
    }
  });
});

describe("writeContractCore unique execution ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
    mockGenerateId.mockReturnValue("test-unique-id");
  });

  it("should generate unique execution ID when no context executionId provided", async () => {
    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(capturedTxContext).not.toBeNull();
    expect(capturedTxContext?.executionId).toMatch(DIRECT_ID_PREFIX_REGEX);
    expect(capturedTxContext?.executionId).not.toBe("direct-execution");
    expect(mockGenerateId).toHaveBeenCalled();
  });

  it("should use provided context executionId when available", async () => {
    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { executionId: "wf-exec-123", organizationId: "org-1" },
    });

    expect(capturedTxContext).not.toBeNull();
    expect(capturedTxContext?.executionId).toBe("wf-exec-123");
  });
});

describe("writeContractCore signer chain ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
  });

  it("should pass resolved chainId to initializeWalletSigner", async () => {
    vi.mocked(getChainIdFromNetwork).mockReturnValue(11_155_111);

    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "11155111",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(initializeWalletSigner).toHaveBeenCalledWith(
      "org-1",
      "https://rpc.example.com",
      11_155_111
    );
  });

  it("should pass mainnet chainId when network is mainnet", async () => {
    vi.mocked(getChainIdFromNetwork).mockReturnValue(1);

    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "1",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(initializeWalletSigner).toHaveBeenCalledWith(
      "org-1",
      "https://rpc.example.com",
      1
    );
  });
});

describe("writeContractCore priorityFeeGwei override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
    mockExecuteContractCall.mockResolvedValue({
      hash: "0xhash",
      gasUsed: BigInt(21_000),
      effectiveGasPrice: BigInt(1_000_000_000),
    });
  });

  it("forwards parsed priorityFeeGwei into adapter gasOverrides.priorityFeeOverride", async () => {
    // 5 gwei in wei -- what parsePriorityFeeGwei("5") would return.
    const fiveGweiWei = BigInt(5e9);
    vi.mocked(parsePriorityFeeGwei).mockReturnValue(fiveGweiWei);

    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "16602",
      abi: VALID_ABI,
      abiFunction: "transfer",
      priorityFeeGwei: "5",
      _context: { organizationId: "org-1" },
    });

    expect(parsePriorityFeeGwei).toHaveBeenCalledWith("5");
    expect(mockExecuteContractCall).toHaveBeenCalled();
    const optionsArg = mockExecuteContractCall.mock.calls[0]?.[3] as {
      gasOverrides: { priorityFeeOverride?: bigint };
    };
    expect(optionsArg.gasOverrides.priorityFeeOverride).toBe(fiveGweiWei);
  });

  it("omits priorityFeeOverride from gasOverrides when input is missing", async () => {
    vi.mocked(parsePriorityFeeGwei).mockReturnValue(undefined);

    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "16602",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(mockExecuteContractCall).toHaveBeenCalled();
    const optionsArg = mockExecuteContractCall.mock.calls[0]?.[3] as {
      gasOverrides: { priorityFeeOverride?: bigint };
    };
    expect(optionsArg.gasOverrides.priorityFeeOverride).toBeUndefined();
  });
});

describe("writeContractCore RPC resolution failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
  });

  // This branch previously omitted errorClass, which made applyFailOnError
  // treat an RPC misconfiguration as a softenable execution failure instead
  // of the SYSTEM-classified config problem it is.
  it("classifies a getRpcProvider failure as SYSTEM so it is exempt from failOnError softening", async () => {
    vi.mocked(getRpcProvider).mockRejectedValueOnce(
      new Error("no RPC providers configured for chain 1")
    );

    const result = await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe(ExecutionErrorType.SYSTEM);
    }
  });
});
