import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    TRANSACTION: "transaction",
  },
  logUserError: vi.fn(),
  // Emitted by the stablecoin ceiling when it refuses an approval.
  logSecurityEvent: vi.fn(),
}));

// supported_tokens rows the stablecoin ceiling reads. Empty by default, so
// the existing cases run against a token the ceiling does not recognise.
const tokenRegistry = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // Two shapes share this stub: most lookups end in .limit(), while
        // loadStablecoin in stablecoin-cap.ts awaits .where() directly because
        // it reads the chain's whole token list and matches in JS. A promise
        // that also carries .limit satisfies both.
        where: () => {
          const pending = Promise.resolve(tokenRegistry.rows) as Promise<
            unknown[]
          > & {
            limit: () => Promise<unknown[]>;
          };
          pending.limit = () => Promise.resolve([]);
          return pending;
        },
      }),
    }),
    query: {
      explorerConfigs: {
        findFirst: () =>
          Promise.resolve({ chainId: 1, baseUrl: "https://etherscan.io" }),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {
    id: "id",
    userId: "userId",
    workflowId: "workflowId",
  },
  explorerConfigs: { id: "id", chainId: "chainId" },
  // decimals/symbol/isStablecoin are read by loadStablecoin: this step calls
  // ERC-20 approve directly, so the stablecoin ceiling is applied here rather
  // than in writeContractCore.
  supportedTokens: {
    id: "id",
    chainId: "chainId",
    tokenAddress: "tokenAddress",
    decimals: "decimals",
    symbol: "symbol",
    isStablecoin: "is_stablecoin",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
}));

// Mock RPC resolution
const mockGetChainIdFromNetwork = vi.fn();
const mockGetRpcProvider = vi.fn();

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
  isSolanaChain: () => false,
}));

// Mock explorer
vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: () => "https://etherscan.io/tx/0xabc",
  getAddressUrl: () => "https://etherscan.io/address/0xabc",
}));

// Mock chain adapter
const mockExecuteContractCall = vi.fn();
const mockGetTransactionUrl = vi.fn();
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    executeContractCall: (...args: unknown[]) =>
      mockExecuteContractCall(...args),
    getTransactionUrl: (...args: unknown[]) => mockGetTransactionUrl(...args),
  }),
}));

// Mock organization context
const mockResolveOrgContext = vi.fn();
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: (...args: unknown[]) =>
    mockResolveOrgContext(...args),
}));

// Mock wallet helpers
const mockGetWalletAddress = vi.fn();
const mockInitializeSigner = vi.fn();
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: (...args: unknown[]) =>
    mockGetWalletAddress(...args),
  initializeWalletSigner: (...args: unknown[]) => mockInitializeSigner(...args),
}));

// Mock gas helpers
vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

const mockGetGasConfig = vi.fn();
vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: () => ({
    getGasConfig: mockGetGasConfig,
  }),
}));

const mockGetNextNonce = vi.fn();
const mockRecordTransaction = vi.fn();
const mockConfirmTransaction = vi.fn();
vi.mock("@/lib/web3/nonce-manager", () => ({
  getNonceManager: () => ({
    getNextNonce: mockGetNextNonce,
    recordTransaction: mockRecordTransaction,
    confirmTransaction: mockConfirmTransaction,
  }),
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: (
    _ctx: unknown,
    _wallet: unknown,
    fn: (session: unknown) => unknown
  ) => fn({ id: "mock-session" }),
  submitContractCallAndConfirm: async (
    contract: Record<
      string,
      (...a: unknown[]) => Promise<{
        hash: string;
        wait: () => Promise<{
          hash: string;
          gasUsed: bigint;
          gasPrice: bigint;
        }>;
      }>
    >,
    method: string,
    args: unknown[],
    overrides: Record<string, unknown>,
    _signer: unknown,
    _options: unknown
  ) => {
    const tx = await contract[method](...args, overrides);
    const receipt = await tx.wait();
    return {
      txHash: receipt.hash,
      receipt,
      gasCostWei: (receipt.gasUsed * receipt.gasPrice).toString(),
      transactionLink: `https://etherscan.io/tx/${receipt.hash}`,
    };
  },
}));

// Mock sponsorship (disabled by default so tests exercise the direct signing path)
vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  isSponsorshipSupported: () => false,
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

vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: vi.fn().mockResolvedValue(null),
}));

const mockTraceExecutedCall = vi.fn();
vi.mock("@/lib/web3/trace-executed-call", () => ({
  traceExecutedCallWithFailover: (...args: unknown[]) =>
    mockTraceExecutedCall(...args),
}));

// Mock ethers
const mockDecimals = vi.fn();
const mockSymbol = vi.fn();
const mockApproveEstimateGas = vi.fn();
const mockApprove = vi.fn();

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        decimals = mockDecimals;
        symbol = mockSymbol;
        approve = Object.assign(mockApprove, {
          staticCall: vi.fn().mockResolvedValue(true),
          estimateGas: mockApproveEstimateGas,
        });
      },
    },
  };
});

vi.mock("@/lib/contracts/abis/erc20.json", () => ({
  default: [
    { name: "approve", type: "function", inputs: [], outputs: [] },
    { name: "decimals", type: "function", inputs: [], outputs: [] },
    { name: "symbol", type: "function", inputs: [], outputs: [] },
  ],
}));

// Must import AFTER all mocks
import type { ApproveTokenCoreInput } from "@/plugins/web3/steps/approve-token-core";
import { approveTokenCore } from "@/plugins/web3/steps/approve-token-core";

const VALID_TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const VALID_SPENDER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
// Deliberately not a protocol contract: the allowlist admits over-cap
// approvals to routers this repo already directs value at, and VALID_SPENDER
// above is one of them, so it cannot exercise the refusal.
const UNKNOWN_SPENDER = "0x000000000000000000000000000000000000dEaD";

function makeInput(
  overrides: Partial<ApproveTokenCoreInput>
): ApproveTokenCoreInput {
  return {
    network: "ethereum",
    tokenConfig: VALID_TOKEN,
    spenderAddress: VALID_SPENDER,
    amount: "100",
    _context: { organizationId: "org-1" },
    ...overrides,
  };
}

function setupMocks(): void {
  mockGetChainIdFromNetwork.mockReturnValue(1);
  mockGetRpcProvider.mockResolvedValue({
    resolveActiveRpcUrl: () => Promise.resolve("https://rpc.example.com"),
    executeWithFailover: (fn: (p: unknown) => unknown) => fn({} as any),
  });
  mockResolveOrgContext.mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: undefined,
  });
  mockGetWalletAddress.mockResolvedValue("0xWalletAddress");
  mockInitializeSigner.mockResolvedValue({
    getAddress: () => Promise.resolve("0xWalletAddress"),
    provider: {},
  });
  mockDecimals.mockResolvedValue(BigInt(18));
  mockSymbol.mockResolvedValue("DAI");
  mockApproveEstimateGas.mockResolvedValue(BigInt(46_000));
  mockGetGasConfig.mockResolvedValue({
    gasLimit: BigInt(60_000),
    maxFeePerGas: BigInt(30_000_000_000),
    maxPriorityFeePerGas: BigInt(1_500_000_000),
  });
  mockGetNextNonce.mockReturnValue(5);
  mockRecordTransaction.mockResolvedValue(undefined);
  mockConfirmTransaction.mockResolvedValue(undefined);
  mockApprove.mockResolvedValue({
    hash: "0xtxhash",
    wait: () =>
      Promise.resolve({
        hash: "0xtxhash",
        gasUsed: BigInt(45_000),
        gasPrice: BigInt(25_000_000_000),
      }),
  });
  mockExecuteContractCall.mockResolvedValue({
    hash: "0xtxhash",
    gasUsed: BigInt(45_000),
    effectiveGasPrice: BigInt(25_000_000_000),
  });
  mockGetTransactionUrl.mockResolvedValue("https://etherscan.io/tx/0xtxhash");
}

const MOCK_EXECUTED_CALL = {
  contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
  functionName: "approve",
  functionSignature: "approve(address,uint256)",
  args: {
    spender: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
    amount: "100000000000000000000",
  },
  sponsored: false,
  topLevelTo: "0x6b175474e89094c44da98b954eedeac495271d0f",
  reverted: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTraceExecutedCall.mockResolvedValue(undefined);
});

describe("approve-token - validation", () => {
  it("fails when token address is invalid", async () => {
    setupMocks();
    const result = await approveTokenCore(
      makeInput({ tokenConfig: "not-an-address" })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No token selected");
    }
  });

  it("fails when spender address is invalid", async () => {
    setupMocks();
    const result = await approveTokenCore(
      makeInput({ spenderAddress: "invalid" })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid spender address");
    }
  });

  it("fails when amount is empty", async () => {
    setupMocks();
    const result = await approveTokenCore(makeInput({ amount: "" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Amount is required");
    }
  });

  it("fails when context is missing", async () => {
    setupMocks();
    const result = await approveTokenCore(makeInput({ _context: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Execution ID or organization ID");
    }
  });
});

describe("approve-token - successful approval", () => {
  it("approves a specific amount", async () => {
    setupMocks();
    const result = await approveTokenCore(makeInput({ amount: "100" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transactionHash).toBe("0xtxhash");
      expect(result.approvedAmount).toBe("100");
      expect(result.spender).toBe(VALID_SPENDER);
      expect(result.symbol).toBe("DAI");
      expect(result.transactionLink).toBe("https://etherscan.io/tx/0xtxhash");
    }
  });

  it("handles max approval", async () => {
    setupMocks();
    const result = await approveTokenCore(makeInput({ amount: "max" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.approvedAmount).toBe("unlimited");
    }
  });

  it("handles max approval case-insensitive", async () => {
    setupMocks();
    const result = await approveTokenCore(makeInput({ amount: " MAX " }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.approvedAmount).toBe("unlimited");
    }
  });

  it("computes gas used correctly", async () => {
    setupMocks();
    const result = await approveTokenCore(makeInput({}));
    expect(result.success).toBe(true);
    if (result.success) {
      // gasUsed=45000, gasPrice=25000000000 -> 1125000000000000
      expect(result.gasUsed).toBe("1125000000000000");
    }
  });
});

describe("approve-token - error handling", () => {
  it("fails when network resolution fails", async () => {
    setupMocks();
    mockGetChainIdFromNetwork.mockImplementation(() => {
      throw new Error("Unknown network: foochain");
    });
    const result = await approveTokenCore(makeInput({ network: "foochain" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unknown network");
    }
  });

  it("fails when amount format is invalid", async () => {
    setupMocks();
    const result = await approveTokenCore(
      makeInput({ amount: "not-a-number" })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid amount format");
    }
  });

  it("fails when transaction reverts", async () => {
    setupMocks();
    mockExecuteContractCall.mockRejectedValueOnce(
      new Error("execution reverted: ERC20: approve from zero address")
    );
    const result = await approveTokenCore(makeInput({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Token approval failed");
    }
  });

  it("fails when wallet initialization fails", async () => {
    setupMocks();
    mockInitializeSigner.mockRejectedValueOnce(new Error("Wallet not found"));
    const result = await approveTokenCore(makeInput({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(
        "Failed to initialize organization wallet"
      );
    }
  });
});

describe("approve-token - executedCall on direct send", () => {
  it("attaches executedCall when trace succeeds", async () => {
    setupMocks();
    mockTraceExecutedCall.mockResolvedValue(MOCK_EXECUTED_CALL);

    const result = await approveTokenCore(makeInput({ amount: "100" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.executedCall).toEqual(MOCK_EXECUTED_CALL);
    }
  });

  it("omits executedCall when trace returns undefined (graceful degradation)", async () => {
    setupMocks();
    mockTraceExecutedCall.mockResolvedValue(undefined);

    const result = await approveTokenCore(makeInput({ amount: "100" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.executedCall).toBeUndefined();
    }
  });

  it("calls traceExecutedCallWithFailover with correct args", async () => {
    setupMocks();
    mockTraceExecutedCall.mockResolvedValue(undefined);

    await approveTokenCore(makeInput({ amount: "100" }));

    expect(mockTraceExecutedCall).toHaveBeenCalledWith(
      expect.objectContaining({ executeWithFailover: expect.any(Function) }),
      "0xtxhash",
      expect.objectContaining({ target: VALID_TOKEN, functionName: "approve" })
    );
  });
});

describe("approve-token stablecoin ceiling", () => {
  // approveTokenCore calls ERC-20 approve directly, so it never passes through
  // writeContractCore where the ceiling is applied. It was the one unbounded
  // allowance path the cap did not cover -- and the cheapest complete drain a
  // leaked key has, since the allowance is granted here and transferFrom
  // happens off platform afterwards where nothing checks.
  beforeEach(() => {
    tokenRegistry.rows = [
      {
        tokenAddress: VALID_TOKEN,
        decimals: 6,
        symbol: "USDC",
        isStablecoin: true,
      },
    ];
  });

  afterEach(() => {
    tokenRegistry.rows = [];
  });

  it("refuses an unlimited approval to a spender nothing accounts for", async () => {
    setupMocks();

    const result = await approveTokenCore(
      makeInput({ amount: "max", spenderAddress: UNKNOWN_SPENDER })
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("per-transaction limit");
    }
  });

  it("refuses an over-cap approval to a spender nothing accounts for", async () => {
    setupMocks();

    const result = await approveTokenCore(
      makeInput({ amount: "5000", spenderAddress: UNKNOWN_SPENDER })
    );

    expect(result.success).toBe(false);
  });

  it("leaves an approval under the ceiling alone", async () => {
    setupMocks();

    const result = await approveTokenCore(makeInput({ amount: "10" }));

    expect(result.success).toBe(true);
  });

  // The case the allowlist exists to preserve, exercised against the REAL
  // protocol registry rather than a mock: approving max uint to a router the
  // platform already directs value at is how nearly every DeFi integration
  // works, and must keep working. VALID_SPENDER is one such contract.
  it("allows an unlimited approval to a contract a protocol already uses", async () => {
    setupMocks();

    const result = await approveTokenCore(
      makeInput({ amount: "max", spenderAddress: VALID_SPENDER })
    );

    expect(result.success).toBe(true);
  });

  it("does not engage for a token that is not a recognised stablecoin", async () => {
    setupMocks();
    tokenRegistry.rows = [];

    const result = await approveTokenCore(
      makeInput({ amount: "max", spenderAddress: UNKNOWN_SPENDER })
    );

    expect(result.success).toBe(true);
  });
});
