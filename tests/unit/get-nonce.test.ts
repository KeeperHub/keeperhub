import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SOLANA_CHAIN_ID, mockGetRpcProvider, mockGetTransactionCount } =
  vi.hoisted(() => ({
    SOLANA_CHAIN_ID: 101,
    mockGetRpcProvider: vi.fn(),
    mockGetTransactionCount: vi.fn(),
  }));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  workflows: { id: "id" },
  explorerConfigs: { id: "id", chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  sql: () => ({}),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (network: string): number => {
    if (network === "ethereum") {
      return 1;
    }
    if (network === "solana") {
      return SOLANA_CHAIN_ID;
    }
    throw new Error(`Unsupported network: ${network}`);
  },
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
  isSolanaChain: (chainId: number): boolean => chainId === SOLANA_CHAIN_ID,
}));

import {
  type GetNonceInput,
  getNonceStep,
} from "@/plugins/web3/steps/get-nonce";

const VALID_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

function makeInput(overrides: Partial<GetNonceInput> = {}): GetNonceInput {
  return { network: "ethereum", address: VALID_ADDRESS, ...overrides };
}

function setCounts(latest: number, pending: number): void {
  mockGetTransactionCount.mockImplementation(
    (_address: string, blockTag: string): Promise<number> =>
      Promise.resolve(blockTag === "pending" ? pending : latest)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn({ getTransactionCount: mockGetTransactionCount }),
  });
  setCounts(5, 7);
});

describe("getNonceStep - reads", () => {
  it("returns both the latest and pending counts from one node", async () => {
    const result = await getNonceStep(makeInput());

    expect(result).toEqual({
      success: true,
      nonce: 5,
      latestNonce: 5,
      pendingNonce: 7,
      pendingCount: 2,
      blockTag: "latest",
      address: VALID_ADDRESS,
    });
    expect(mockGetTransactionCount).toHaveBeenCalledTimes(2);
    expect(mockGetTransactionCount).toHaveBeenCalledWith(
      VALID_ADDRESS,
      "latest"
    );
    expect(mockGetTransactionCount).toHaveBeenCalledWith(
      VALID_ADDRESS,
      "pending"
    );
  });

  it("reports the pending count as nonce when blockTag is pending", async () => {
    const result = await getNonceStep(makeInput({ blockTag: "pending" }));

    expect(result).toMatchObject({
      success: true,
      nonce: 7,
      blockTag: "pending",
      latestNonce: 5,
      pendingNonce: 7,
    });
  });

  it("falls back to the latest count when blockTag is empty", async () => {
    const result = await getNonceStep(makeInput({ blockTag: "" }));

    expect(result).toMatchObject({
      success: true,
      nonce: 5,
      blockTag: "latest",
    });
  });

  it("reports zero pendingCount when nothing is waiting", async () => {
    setCounts(12, 12);

    const result = await getNonceStep(makeInput());

    expect(result).toMatchObject({ success: true, pendingCount: 0 });
  });

  it("never reports a negative pendingCount", async () => {
    setCounts(9, 8);

    const result = await getNonceStep(makeInput({ blockTag: "pending" }));

    expect(result).toMatchObject({
      success: true,
      nonce: 8,
      latestNonce: 9,
      pendingNonce: 8,
      pendingCount: 0,
    });
  });
});

describe("getNonceStep - validation", () => {
  it.each([undefined, false])(
    "rejects an invalid address before any RPC call (failOnError=%s)",
    async (failOnError) => {
      const result = await getNonceStep(
        makeInput({ address: "not-an-address", failOnError })
      );

      expect(result).toMatchObject({
        success: false,
        error: "Invalid Ethereum address: not-an-address",
      });
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
      expect(mockGetTransactionCount).not.toHaveBeenCalled();
    }
  );

  it("rejects an unknown block tag before any RPC call", async () => {
    const result = await getNonceStep(makeInput({ blockTag: "finalized" }));

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid block tag: finalized"),
    });
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("hard-fails a Solana network even when the toggle is off", async () => {
    const result = await getNonceStep(
      makeInput({ network: "solana", failOnError: false })
    );

    expect(result.success).toBe(false);
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });
});

describe("getNonceStep - failOnError", () => {
  it("hard-fails a failed RPC read by default", async () => {
    mockGetTransactionCount.mockRejectedValue(new Error("connection lost"));

    const result = await getNonceStep(makeInput());

    expect(result).toEqual({
      success: false,
      error: "Failed to read nonce: connection lost",
    });
  });

  it("softens a failed RPC read when the toggle is off", async () => {
    mockGetTransactionCount.mockRejectedValue(new Error("connection lost"));

    const result = await getNonceStep(
      makeInput({ blockTag: "pending", failOnError: false })
    );

    // Null, not 0: a read that never completed must not look like an idle wallet.
    expect(result).toEqual({
      success: true,
      nonce: null,
      latestNonce: null,
      pendingNonce: null,
      pendingCount: null,
      blockTag: "pending",
      address: VALID_ADDRESS,
      error: "Failed to read nonce: connection lost",
    });
  });

  it("still hard-fails an unresolved RPC config when the toggle is off", async () => {
    mockGetRpcProvider.mockRejectedValue(new Error("RPC config not found"));

    const result = await getNonceStep(makeInput({ failOnError: false }));

    expect(result).toMatchObject({
      success: false,
      error: "RPC config not found",
    });
    expect(mockGetTransactionCount).not.toHaveBeenCalled();
  });
});
