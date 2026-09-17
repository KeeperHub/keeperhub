import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// supported_tokens rows the stablecoin ceiling reads, set per test.
const registry = vi.hoisted(() => ({
  tokenRows: [] as Array<{
    tokenAddress: string;
    decimals: number;
    symbol: string;
    isStablecoin: boolean;
  }>,
}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    TRANSACTION: "transaction",
  },
  logUserError: vi.fn(),
  logSystemWarn: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // The stablecoin ceiling awaits where() directly (it reads the chain's
        // whole token list); other lookups end in limit().
        where: () =>
          Object.assign(Promise.resolve(registry.tokenRows), {
            limit: () => Promise.resolve([]),
          }),
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
  workflowExecutions: { id: "id", userId: "userId", workflowId: "workflowId" },
  explorerConfigs: { id: "id", chainId: "chainId" },
  supportedTokens: {
    id: "id",
    chainId: "chainId",
    tokenAddress: "tokenAddress",
    decimals: "decimals",
    symbol: "symbol",
    isStablecoin: "isStablecoin",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
}));

vi.mock("@/lib/utils", async () =>
  (await import("../mocks/step-mocks")).utilsGetErrorMessage()
);

vi.mock("@/lib/utils/id", () => ({
  generateId: vi.fn().mockReturnValue("test-unique-id"),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn().mockReturnValue(1),
}));

const mockExecuteWithFailover = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockImplementation(() =>
    Promise.resolve({
      resolveActiveRpcUrl: vi.fn().mockResolvedValue("https://rpc.example.com"),
      executeWithFailover: mockExecuteWithFailover,
    })
  ),
}));

vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: vi
    .fn()
    .mockReturnValue("https://etherscan.io/tx/0xtxhash"),
  getAddressUrl: vi.fn().mockReturnValue("https://etherscan.io/address/0xabc"),
}));

const mockExecuteContractCall = vi.fn();
const mockGetTransactionUrl = vi.fn();
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    executeContractCall: (...args: unknown[]) =>
      mockExecuteContractCall(...args),
    getTransactionUrl: (...args: unknown[]) => mockGetTransactionUrl(...args),
  }),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: undefined,
  }),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi.fn().mockResolvedValue("0xWalletAddress"),
  initializeWalletSigner: vi.fn().mockResolvedValue({
    getAddress: () => Promise.resolve("0xWalletAddress"),
    provider: {},
  }),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  classifyRevert: vi.fn().mockReturnValue({ kind: "unknown" }),
  formatContractError: vi.fn().mockReturnValue("contract error"),
}));

vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  isSponsorshipSupported: () => true,
}));

vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: () => true,
}));

const mockExecuteSponsored = vi.fn();
vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: (...args: unknown[]) =>
    mockExecuteSponsored(...args),
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerMode: vi
    .fn()
    .mockResolvedValue({ kind: "eoa", ownerAddress: "0xWalletAddress" }),
  resolveSignerForNode: vi
    .fn()
    .mockResolvedValue({ kind: "eoa", ownerAddress: "0xWalletAddress" }),
}));

vi.mock("@/lib/safe/execute-as-safe", () => ({
  executeContractCallAsSafe: vi.fn(),
  executeNativeTransferAsSafe: vi.fn(),
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: (
    _ctx: unknown,
    _wallet: unknown,
    fn: (session: unknown) => unknown
  ) => fn({ id: "mock-session" }),
}));

const mockTraceExecutedCall = vi.fn();
vi.mock("@/lib/web3/trace-executed-call", () => ({
  traceExecutedCallWithFailover: (...args: unknown[]) =>
    mockTraceExecutedCall(...args),
}));

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        decimals = vi.fn().mockResolvedValue(BigInt(18));
        symbol = vi.fn().mockResolvedValue("USDC");
        // 100 tokens with 18 decimals - enough to cover the test transfer of 10
        balanceOf = vi.fn().mockResolvedValue(BigInt("100000000000000000000"));
        interface = {};
        transfer = Object.assign(vi.fn(), {
          staticCall: vi.fn().mockResolvedValue(true),
          estimateGas: vi.fn().mockResolvedValue(BigInt(46_000)),
        });
      },
    },
  };
});

vi.mock("@/lib/contracts/abis/erc20.json", () => ({
  default: [
    { name: "transfer", type: "function", inputs: [], outputs: [] },
    { name: "decimals", type: "function", inputs: [], outputs: [] },
    { name: "symbol", type: "function", inputs: [], outputs: [] },
  ],
}));

import { SponsoredTxPendingError } from "@/lib/web3/turnkey-revert";
import type { TransferTokenCoreInput } from "@/plugins/web3/steps/transfer-token-core";
import { transferTokenCore } from "@/plugins/web3/steps/transfer-token-core";

const VALID_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const VALID_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function makeInput(
  overrides: Partial<TransferTokenCoreInput> = {}
): TransferTokenCoreInput {
  return {
    network: "ethereum",
    tokenConfig: VALID_TOKEN,
    recipientAddress: VALID_RECIPIENT,
    amount: "10",
    _context: { organizationId: "org-1" },
    ...overrides,
  };
}

function setupMocks(): void {
  mockExecuteContractCall.mockResolvedValue({
    hash: "0xtxhash",
    gasUsed: BigInt(45_000),
    effectiveGasPrice: BigInt(25_000_000_000),
  });
  mockGetTransactionUrl.mockResolvedValue("https://etherscan.io/tx/0xtxhash");
  mockTraceExecutedCall.mockResolvedValue(undefined);
  // executeWithFailover must invoke the callback so the balanceOf/decimals/symbol
  // calls inside transfer-token-core actually run (returning from the MockContract).
  mockExecuteWithFailover.mockImplementation(
    (fn: (provider: unknown) => unknown) => fn({})
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registry.tokenRows = [];
  setupMocks();
});

describe("transfer-token-core - a sponsored send that ends pending", () => {
  // Turnkey accepted the send but no hash came back in time. The activity id
  // is then the only handle on a transaction that may still reach the chain,
  // so the step result has to keep it.
  it("keeps Turnkey's status id when no hash was assigned", async () => {
    mockExecuteSponsored.mockRejectedValue(
      new SponsoredTxPendingError({
        message: "outcome unknown",
        sendTransactionStatusId: "status-123",
      })
    );

    const result = await transferTokenCore(makeInput());

    expect(result).toMatchObject({
      success: false,
      sponsored: true,
      sendTransactionStatusId: "status-123",
    });
    expect(result).not.toHaveProperty("transactionHash");
    // Never re-sent through direct signing.
    expect(mockExecuteContractCall).not.toHaveBeenCalled();
  });

  it("keeps both the hash and the status id once a hash exists", async () => {
    mockExecuteSponsored.mockRejectedValue(
      new SponsoredTxPendingError({
        message: "receipt unreadable",
        sendTransactionStatusId: "status-456",
        txHash: "0xbroadcast",
      })
    );

    const result = await transferTokenCore(makeInput());

    expect(result).toMatchObject({
      success: false,
      transactionHash: "0xbroadcast",
      sendTransactionStatusId: "status-456",
    });
  });

  it("adds no status id when Turnkey never assigned one", async () => {
    mockExecuteSponsored.mockRejectedValue(
      new SponsoredTxPendingError({ message: "transport failure" })
    );

    const result = await transferTokenCore(makeInput());

    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("sendTransactionStatusId");
  });
});
