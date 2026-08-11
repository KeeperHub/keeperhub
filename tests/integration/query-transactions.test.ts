import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: server-only
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Hoisted mock references (vi.mock factories are hoisted above const decls)
// ---------------------------------------------------------------------------
const {
  mockParseResults,
  mockGetBlockNumber,
  mockDbSelectLimit,
  mockFindFirstExplorer,
  mockFetchContractTransactions,
  mockGetAddressUrl,
  mockGetTransactionUrl,
  mockResolveExplorerUrlConfig,
  mockGetChainIdFromNetwork,
  mockGetRpcProvider,
} = vi.hoisted(() => ({
  mockParseResults: new Map<
    string,
    {
      name: string;
      signature: string;
      args: unknown[];
      fragment: { inputs: { name: string }[] };
    }
  >(),
  mockGetBlockNumber: vi.fn().mockResolvedValue(20_000_000),
  mockDbSelectLimit: vi.fn().mockResolvedValue([{ userId: "user_123" }]),
  mockFindFirstExplorer: vi.fn(),
  mockFetchContractTransactions: vi.fn(),
  mockGetAddressUrl: vi.fn(),
  mockGetTransactionUrl: vi.fn(),
  mockResolveExplorerUrlConfig: vi.fn((config: unknown) => config),
  mockGetChainIdFromNetwork: vi.fn(),
  mockGetRpcProvider: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: ethers
// ---------------------------------------------------------------------------
vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn(
      (addr: string) => addr.startsWith("0x") && addr.length === 42
    ),
    Interface: class MockInterface {
      private readonly abi: Array<{
        type: string;
        name: string;
        inputs?: Array<{ name: string }>;
      }>;

      constructor(abi: unknown[]) {
        this.abi = abi as Array<{
          type: string;
          name: string;
          inputs?: Array<{ name: string }>;
        }>;
      }

      getFunction(name: string): {
        name: string;
        inputs: Array<{ name: string }>;
      } | null {
        const fn = this.abi.find(
          (e) => e.type === "function" && e.name === name
        );
        if (!fn) {
          return null;
        }
        return {
          name: fn.name,
          inputs: (fn.inputs ?? []).map((inp) => ({ name: inp.name })),
        };
      }

      parseTransaction(tx: { data: string; value: string }): {
        name: string;
        signature: string;
        args: unknown[];
        fragment: { inputs: { name: string }[] };
      } | null {
        return mockParseResults.get(tx.data) ?? null;
      }
    },
    JsonRpcProvider: class MockJsonRpcProvider {
      getBlockNumber = mockGetBlockNumber;
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/db
// ---------------------------------------------------------------------------
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: mockDbSelectLimit,
        }),
      }),
    }),
    query: {
      explorerConfigs: {
        findFirst: mockFindFirstExplorer,
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/db/schema
// ---------------------------------------------------------------------------
vi.mock("@/lib/db/schema", () => ({
  explorerConfigs: { chainId: "explorerConfigs.chainId" },
  workflowExecutions: {
    id: "workflowExecutions.id",
    userId: "workflowExecutions.userId",
  },
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/explorer
// ---------------------------------------------------------------------------
vi.mock("@/lib/explorer", () => ({
  fetchContractTransactions: mockFetchContractTransactions,
  getAddressUrl: mockGetAddressUrl,
  getTransactionUrl: mockGetTransactionUrl,
  resolveExplorerUrlConfig: mockResolveExplorerUrlConfig,
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/rpc/network-utils
// ---------------------------------------------------------------------------
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: mockGetChainIdFromNetwork,
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/rpc/provider-factory
// ---------------------------------------------------------------------------
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/utils
// ---------------------------------------------------------------------------
vi.mock("@/lib/utils", () => ({
  getErrorMessage: vi.fn(
    (error: unknown) =>
      (error as { message?: string })?.message ?? String(error)
  ),
}));

import type { NormalizedTransaction } from "@/lib/explorer";
// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks
// ---------------------------------------------------------------------------
import { queryTransactionsCore } from "@/plugins/web3/steps/query-transactions-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TRANSFER_ABI = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
]);

const VALID_CONTRACT = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const VALID_SENDER = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

const MOCK_EXPLORER_CONFIG = {
  id: "explorer_1",
  chainId: 1,
  chainType: "evm",
  explorerUrl: "https://etherscan.io",
  explorerApiType: "etherscan",
  explorerApiUrl: "https://api.etherscan.io/v2/api",
  explorerTxPath: "/tx/{hash}",
  explorerAddressPath: "/address/{address}",
  explorerContractPath: "/address/{address}#code",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createMockTx(
  overrides: Partial<NormalizedTransaction> = {}
): NormalizedTransaction {
  return {
    hash: "0xtx1",
    from: VALID_SENDER,
    to: VALID_CONTRACT,
    value: "0",
    input: "0xtransfer_data",
    blockNumber: 19_999_500,
    timestamp: "1700000000",
    isError: false,
    ...overrides,
  };
}

function defaultInput(): {
  network: string;
  contractAddress: string;
  abi: string;
  abiFunction: string;
  _context: { executionId: string };
} {
  return {
    network: "mainnet",
    contractAddress: VALID_CONTRACT,
    abi: TRANSFER_ABI,
    abiFunction: "transfer",
    _context: { executionId: "exec_123" },
  };
}

function registerParseResult(
  inputData: string,
  opts: {
    name: string;
    argNames: string[];
    argValues: unknown[];
  }
): void {
  mockParseResults.set(inputData, {
    name: opts.name,
    signature: `${opts.name}()`,
    args: opts.argValues,
    fragment: {
      inputs: opts.argNames.map((n) => ({ name: n })),
    },
  });
}

// ---------------------------------------------------------------------------
// Default mock setup helper
// ---------------------------------------------------------------------------
function setupDefaultMocks(): void {
  mockGetChainIdFromNetwork.mockReturnValue(1);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn({ getBlockNumber: mockGetBlockNumber }),
  });
  mockFindFirstExplorer.mockResolvedValue(MOCK_EXPLORER_CONFIG);
  mockGetAddressUrl.mockReturnValue(
    `https://etherscan.io/address/${VALID_CONTRACT}`
  );
  mockGetTransactionUrl.mockImplementation(
    (_config: unknown, hash: string) => `https://etherscan.io/tx/${hash}`
  );
  mockGetBlockNumber.mockResolvedValue(20_000_000);
  mockDbSelectLimit.mockResolvedValue([{ userId: "user_123" }]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("queryTransactionsCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseResults.clear();
    setupDefaultMocks();
  });

  // =========================================================================
  // Happy path
  // =========================================================================

  it("returns decoded transactions matching the target function", async () => {
    const tx1 = createMockTx({ hash: "0xaaa", input: "0xdata_transfer_1" });
    const tx2 = createMockTx({ hash: "0xbbb", input: "0xdata_transfer_2" });
    const tx3 = createMockTx({ hash: "0xccc", input: "0xdata_approve" });

    registerParseResult("0xdata_transfer_1", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xRecipient1", "1000"],
    });
    registerParseResult("0xdata_transfer_2", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xRecipient2", "2000"],
    });
    registerParseResult("0xdata_approve", {
      name: "approve",
      argNames: ["spender", "amount"],
      argValues: ["0xSpender", "500"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx1, tx2, tx3],
    });

    const result = await queryTransactionsCore(defaultInput());

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.matchCount).toBe(2);
    expect(result.totalFetched).toBe(3);
    expect(result.transactions).toHaveLength(2);

    const first = result.transactions[0];
    expect(first.hash).toBe("0xaaa");
    expect(first.from).toBe(VALID_SENDER);
    expect(first.to).toBe(VALID_CONTRACT);
    expect(first.value).toBe("0");
    expect(first.blockNumber).toBe(19_999_500);
    expect(first.timestamp).toBe("1700000000");
    expect(first.functionName).toBe("transfer");
    expect(first.functionSignature).toBe("transfer()");
    expect(first.args).toEqual({ to: "0xRecipient1", amount: "1000" });
    expect(first.transactionLink).toBe("https://etherscan.io/tx/0xaaa");

    expect(result.contractAddressLink).toBe(
      `https://etherscan.io/address/${VALID_CONTRACT}`
    );
  });

  it("returns zero matches when no transactions call the target function", async () => {
    const tx = createMockTx({ input: "0xdata_other" });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx],
    });

    const result = await queryTransactionsCore(defaultInput());

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.matchCount).toBe(0);
    expect(result.transactions).toHaveLength(0);
    expect(result.totalFetched).toBe(1);
  });

  it("filters transactions by argument values", async () => {
    const tx1 = createMockTx({ hash: "0xaaa", input: "0xdata_t1" });
    const tx2 = createMockTx({ hash: "0xbbb", input: "0xdata_t2" });

    registerParseResult("0xdata_t1", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xTarget", "1000"],
    });
    registerParseResult("0xdata_t2", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xOther", "2000"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx1, tx2],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: '["0xTarget", "1000"]',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.matchCount).toBe(1);
    expect(result.transactions[0].hash).toBe("0xaaa");
  });

  it("treats empty-string args as wildcards in the filter", async () => {
    const tx1 = createMockTx({ hash: "0xaaa", input: "0xdata_w1" });
    const tx2 = createMockTx({ hash: "0xbbb", input: "0xdata_w2" });

    registerParseResult("0xdata_w1", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAny1", "1000"],
    });
    registerParseResult("0xdata_w2", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAny2", "2000"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx1, tx2],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: '["", "1000"]',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.matchCount).toBe(1);
    expect(result.transactions[0].hash).toBe("0xaaa");
  });

  it("matches arg filter values case-insensitively for addresses", async () => {
    const tx = createMockTx({ hash: "0xaaa", input: "0xdata_case" });

    registerParseResult("0xdata_case", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAbCdEf0123456789000000000000000000000001", "500"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: '["0xabcdef0123456789000000000000000000000001", "500"]',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.matchCount).toBe(1);
    expect(result.transactions[0].hash).toBe("0xaaa");
  });

  // =========================================================================
  // Error cases
  // =========================================================================

  it("returns error for invalid contract address", async () => {
    const result = await queryTransactionsCore({
      ...defaultInput(),
      contractAddress: "not-an-address",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("Invalid contract address");
  });

  it("returns error for invalid ABI JSON", async () => {
    const result = await queryTransactionsCore({
      ...defaultInput(),
      abi: "{ broken json !!",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("Invalid ABI JSON");
  });

  it("returns error when function is not found in ABI", async () => {
    const result = await queryTransactionsCore({
      ...defaultInput(),
      abiFunction: "nonExistentFunction",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("not found in ABI");
  });

  it("returns error for unsupported network", async () => {
    mockGetChainIdFromNetwork.mockImplementation(() => {
      throw new Error("Unsupported network: zora");
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      network: "zora",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("Unsupported network");
  });

  it("returns error when RPC config is not available (chain disabled)", async () => {
    mockGetRpcProvider.mockRejectedValue(
      new Error("Chain 1 not found or not enabled")
    );

    const result = await queryTransactionsCore(defaultInput());

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("not found or not enabled");
  });

  it("returns error when no explorer config exists in the database", async () => {
    mockFindFirstExplorer.mockResolvedValue(undefined);

    const result = await queryTransactionsCore(defaultInput());

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("No explorer configuration");
  });

  it("propagates error from explorer API failure", async () => {
    mockFetchContractTransactions.mockResolvedValue({
      success: false,
      error: "rate limit exceeded",
    });

    const result = await queryTransactionsCore(defaultInput());

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toBe("rate limit exceeded");
  });

  // =========================================================================
  // Block range
  // =========================================================================

  it("returns empty success result when fromBlock > toBlock", async () => {
    const result = await queryTransactionsCore({
      ...defaultInput(),
      fromBlock: "20000000",
      toBlock: "19000000",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.transactions).toHaveLength(0);
    expect(result.matchCount).toBe(0);
    expect(result.totalFetched).toBe(0);
    expect(result.fromBlock).toBe(20_000_000);
    expect(result.toBlock).toBe(19_000_000);
    expect(mockFetchContractTransactions).not.toHaveBeenCalled();
  });

  it("uses explicit fromBlock and toBlock directly", async () => {
    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [],
    });

    await queryTransactionsCore({
      ...defaultInput(),
      fromBlock: "15000000",
      toBlock: "15001000",
    });

    const [, , , fromBlock, toBlock] =
      mockFetchContractTransactions.mock.calls[0];
    expect(fromBlock).toBe(15_000_000);
    expect(toBlock).toBe(15_001_000);
  });

  it("computes fromBlock using blockCount lookback from latest block", async () => {
    mockGetBlockNumber.mockResolvedValue(20_000_000);
    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [],
    });

    await queryTransactionsCore({
      ...defaultInput(),
      blockCount: 1000,
    });

    const [, , , fromBlock, toBlock] =
      mockFetchContractTransactions.mock.calls[0];
    expect(fromBlock).toBe(19_999_000);
    expect(toBlock).toBe(20_000_000);
  });

  it("uses default 6500 lookback when no block params are provided", async () => {
    mockGetBlockNumber.mockResolvedValue(20_000_000);
    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [],
    });

    await queryTransactionsCore(defaultInput());

    const [, , , fromBlock, toBlock] =
      mockFetchContractTransactions.mock.calls[0];
    expect(fromBlock).toBe(19_993_500);
    expect(toBlock).toBe(20_000_000);
  });

  // =========================================================================
  // functionArgs parsing
  // =========================================================================

  it("parses functionArgs from a JSON string", async () => {
    const tx = createMockTx({ hash: "0xaaa", input: "0xdata_json" });

    registerParseResult("0xdata_json", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xRecipient", "100"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: '["0xRecipient", "100"]',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.matchCount).toBe(1);
  });

  it("uses functionArgs directly when provided as an array", async () => {
    const tx = createMockTx({ hash: "0xaaa", input: "0xdata_arr" });

    registerParseResult("0xdata_arr", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xRecipient", "100"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: ["0xRecipient", "100"],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.matchCount).toBe(1);
  });

  it("treats all-empty array functionArgs as no filter (matches all)", async () => {
    const tx1 = createMockTx({ hash: "0xaaa", input: "0xdata_e1" });
    const tx2 = createMockTx({ hash: "0xbbb", input: "0xdata_e2" });

    registerParseResult("0xdata_e1", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAddr1", "100"],
    });
    registerParseResult("0xdata_e2", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAddr2", "200"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx1, tx2],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: ["", ""],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.matchCount).toBe(2);
  });

  it("treats invalid JSON functionArgs as no filter (matches all)", async () => {
    const tx1 = createMockTx({ hash: "0xaaa", input: "0xdata_inv1" });
    const tx2 = createMockTx({ hash: "0xbbb", input: "0xdata_inv2" });

    registerParseResult("0xdata_inv1", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAddr1", "100"],
    });
    registerParseResult("0xdata_inv2", {
      name: "transfer",
      argNames: ["to", "amount"],
      argValues: ["0xAddr2", "200"],
    });

    mockFetchContractTransactions.mockResolvedValue({
      success: true,
      transactions: [tx1, tx2],
    });

    const result = await queryTransactionsCore({
      ...defaultInput(),
      functionArgs: "not-valid-json",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.matchCount).toBe(2);
  });
});
