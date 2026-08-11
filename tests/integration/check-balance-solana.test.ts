import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn((a: string) => a.startsWith("0x") && a.length === 42),
    formatUnits: vi.fn((value: bigint, decimals: number) =>
      (Number(value) / 10 ** decimals).toString()
    ),
  },
}));

const { mockGetBalance, mockGetAddressUrl, mockGetRpcProvider } = vi.hoisted(
  () => ({
    mockGetBalance: vi.fn(),
    mockGetAddressUrl: vi.fn(),
    mockGetRpcProvider: vi.fn(),
  })
);

// Fake Solana adapter: the real one would resolve an on-chain RPC provider.
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
    getAddressUrl: (...args: unknown[]) => mockGetAddressUrl(...args),
  }),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn((network: string) => {
    if (network === "solana-devnet") {
      return 103;
    }
    if (network === "mainnet") {
      return 1;
    }
    throw new Error(`Unsupported network: ${network}`);
  }),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
  isSolanaChain: (chainId: number) => chainId === 101 || chainId === 103,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ userId: "user_1" }]) }),
      }),
    }),
  },
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (error: { message?: string }) =>
    error?.message ?? String(error),
}));

import { checkBalanceStep } from "@/plugins/web3/steps/check-balance";

const VALID_SOL = "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL";

const context = () => ({
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Get SOL Balance",
  nodeType: "check-balance" as const,
});

describe("checkBalanceStep - Solana", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAddressUrl.mockResolvedValue(
      "https://solscan.io/account/x?cluster=devnet"
    );
  });

  it("formats the SOL balance at 9 decimals and skips EVM RPC resolution", async () => {
    mockGetBalance.mockResolvedValue(BigInt(2_500_000_000)); // 2.5 SOL

    const result = await checkBalanceStep({
      network: "solana-devnet",
      address: VALID_SOL,
      _context: context(),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance).toBe("2.5");
      expect(result.balanceWei).toBe("2500000000");
      expect(result.address).toBe(VALID_SOL);
    }
    // The Solana path must not resolve an EVM RPC provider...
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
    // ...and fetches the balance with an undefined rpcManager.
    expect(mockGetBalance).toHaveBeenCalledWith(undefined, VALID_SOL);
  });

  it("rejects an invalid Solana address before fetching a balance", async () => {
    const result = await checkBalanceStep({
      network: "solana-devnet",
      address: "not a valid base58 address",
      _context: context(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid Solana address");
    }
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});
