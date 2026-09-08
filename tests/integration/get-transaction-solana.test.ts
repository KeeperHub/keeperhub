import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("ethers", () => ({
  ethers: {
    formatEther: vi.fn((value: bigint) => value.toString()),
  },
}));

const { mockConnectionGetTransaction, mockGetSolanaProvider } = vi.hoisted(
  () => ({
    mockConnectionGetTransaction: vi.fn(),
    mockGetSolanaProvider: vi.fn(),
  })
);

// Fake adapter: constructed directly (not via the shared registry) so the
// step can thread userId into getSolanaProvider - see fetchSolanaTransaction
// in get-transaction.ts. executeWithSolanaFailover both exercises the
// userId-carrying provider factory (for assertions below) and hands back a
// fake connection.
vi.mock("@/lib/web3/chain-adapter/solana", () => ({
  SolanaChainAdapter: class MockSolanaChainAdapter {
    private readonly providerFactory: () => unknown;
    constructor(_chainId: number, providerFactory: () => unknown) {
      this.providerFactory = providerFactory;
    }
    async executeWithSolanaFailover(fn: (connection: unknown) => unknown) {
      await this.providerFactory();
      return fn({
        getTransaction: (...args: unknown[]) =>
          mockConnectionGetTransaction(...args),
      });
    }
  },
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn((network: string) => {
    if (network === "solana-devnet") {
      return 103;
    }
    throw new Error(`Unsupported network: ${network}`);
  }),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(),
  getSolanaProvider: (...args: unknown[]) => mockGetSolanaProvider(...args),
  isSolanaChain: (chainId: number) => chainId === 101 || chainId === 103,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ userId: "user_1" }]) }),
      }),
    }),
    query: {
      explorerConfigs: {
        findFirst: () =>
          Promise.resolve({
            id: "cfg_1",
            chainId: 103,
            explorerUrl: "https://solscan.io",
          }),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  explorerConfigs: { id: "id", chainId: "chainId" },
  workflowExecutions: { id: "id", userId: "userId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: (_config: unknown, hash: string) =>
    `https://solscan.io/tx/${hash}`,
  getAddressUrl: (_config: unknown, address: string) =>
    `https://solscan.io/account/${address}`,
}));

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    getErrorMessage: (error: { message?: string }) =>
      error?.message ?? String(error),
  };
});

import { getTransactionStep } from "@/plugins/web3/steps/get-transaction";

const VALID_SIGNATURE =
  "4XR92Zct9ZodXzisJ4kov3upmTvMotYVrg65MHP8aoCjSPJwUa7vjaXK5VhDF7ZiiF16v7cY5BPazCLnVqZ3yzb";
const FEE_PAYER = "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL";

function fakeSolanaTx(
  overrides: { computeUnits?: number; slot?: number } = {}
) {
  return {
    slot: overrides.slot ?? 12_345,
    meta: {
      computeUnitsConsumed: overrides.computeUnits ?? 5000,
      loadedAddresses: undefined,
    },
    transaction: {
      message: {
        getAccountKeys: () => ({
          get: (i: number) =>
            i === 0 ? { toBase58: () => FEE_PAYER } : undefined,
        }),
      },
    },
  };
}

const context = () => ({
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Get Transaction",
  nodeType: "get-transaction" as const,
});

describe("getTransactionStep - Solana", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSolanaProvider.mockResolvedValue({ executeWithFailover: vi.fn() });
  });

  it("fetches a Solana transaction and maps fee payer, slot, and compute units", async () => {
    mockConnectionGetTransaction.mockResolvedValue(fakeSolanaTx());

    const result = await getTransactionStep({
      network: "solana-devnet",
      transactionHash: VALID_SIGNATURE,
      _context: context(),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.hash).toBe(VALID_SIGNATURE);
      expect(result.from).toBe(FEE_PAYER);
      expect(result.to).toBeNull();
      expect(result.blockNumber).toBe(12_345);
      // gasLimit has no Solana equivalent; actual usage is a separate field.
      expect(result.gasLimit).toBe("0");
      expect(result.computeUnitsConsumed).toBe("5000");
    }
  });

  it("threads the caller's userId into the Solana RPC provider", async () => {
    mockConnectionGetTransaction.mockResolvedValue(fakeSolanaTx());

    await getTransactionStep({
      network: "solana-devnet",
      transactionHash: VALID_SIGNATURE,
      _context: context(),
    });

    expect(mockGetSolanaProvider).toHaveBeenCalledWith({
      chainId: 103,
      userId: "user_1",
    });
  });

  it("returns not-found when the signature doesn't resolve to a transaction", async () => {
    mockConnectionGetTransaction.mockResolvedValue(null);

    const result = await getTransactionStep({
      network: "solana-devnet",
      transactionHash: VALID_SIGNATURE,
      _context: context(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Transaction not found");
    }
  });

  it("rejects an invalid Solana signature before touching the chain", async () => {
    const result = await getTransactionStep({
      network: "solana-devnet",
      transactionHash: "not a valid base58 signature",
      _context: context(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid transaction hash format");
    }
    expect(mockConnectionGetTransaction).not.toHaveBeenCalled();
  });
});

describe("getTransactionStep - failOnError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("softens a not-found lookup when the toggle is off", async () => {
    mockConnectionGetTransaction.mockResolvedValue(null);

    const result = await getTransactionStep({
      network: "solana-devnet",
      transactionHash: VALID_SIGNATURE,
      failOnError: false,
      _context: context(),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.hash).toBeNull();
    expect(result.from).toBeNull();
    expect(result.error).toContain("Transaction not found");
  });

  it("softens a failed lookup when the toggle is off", async () => {
    mockConnectionGetTransaction.mockRejectedValue(new Error("RPC down"));

    const result = await getTransactionStep({
      network: "solana-devnet",
      transactionHash: VALID_SIGNATURE,
      failOnError: false,
      _context: context(),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.error).toContain("Failed to fetch transaction");
  });

  it("still hard-fails an invalid signature when the toggle is off", async () => {
    const result = await getTransactionStep({
      network: "solana-devnet",
      transactionHash: "not a valid base58 signature",
      failOnError: false,
      _context: context(),
    });

    expect(result.success).toBe(false);
    expect(mockConnectionGetTransaction).not.toHaveBeenCalled();
  });
});
