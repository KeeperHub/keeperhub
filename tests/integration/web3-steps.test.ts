import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock server-only module
vi.mock("server-only", () => ({}));

// Mock ethers with proper class constructors
vi.mock("ethers", () => {
  const mockGetBalance = vi
    .fn()
    .mockResolvedValue(BigInt(5_000_000_000_000_000_000));

  return {
    ethers: {
      isAddress: vi.fn(
        (addr: string) => addr.startsWith("0x") && addr.length === 42
      ),
      formatEther: vi.fn((wei: bigint) => (Number(wei) / 1e18).toString()),
      formatUnits: vi.fn((value: bigint, decimals: number) =>
        (Number(value) / 10 ** decimals).toString()
      ),
      parseEther: vi.fn((eth: string) =>
        BigInt(Math.floor(Number.parseFloat(eth) * 1e18))
      ),
      Contract: class MockContract {
        balanceOf = vi
          .fn()
          .mockResolvedValue(BigInt(1_000_000_000_000_000_000));
        transfer = vi.fn().mockResolvedValue({
          hash: "0xtxhash123",
          wait: vi.fn().mockResolvedValue({
            hash: "0xtxhash123",
            blockNumber: 12_345,
            status: 1,
          }),
        });
      },
      JsonRpcProvider: class MockJsonRpcProvider {
        getBalance = mockGetBalance;
      },
    },
  };
});

// Mock RPC provider
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn((network: string) => {
    const map: Record<string, number> = {
      mainnet: 1,
      sepolia: 11_155_111,
      base: 8453,
    };
    if (!map[network]) {
      throw new Error(`Unsupported network: ${network}`);
    }
    return map[network];
  }),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockResolvedValue({
    executeWithFailover: vi.fn(
      async (operation: (provider: unknown) => Promise<unknown>) => {
        const mockProvider = {
          getBalance: vi
            .fn()
            .mockResolvedValue(BigInt(5_000_000_000_000_000_000)),
        };
        return await operation(mockProvider);
      }
    ),
  }),
  isSolanaChain: () => false,
}));

// Mock database
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ userId: "user_123" }]),
        }),
      }),
    }),
    query: {
      explorerConfigs: {
        findFirst: vi.fn().mockResolvedValue({
          chainId: 1,
          explorerUrl: "https://etherscan.io",
          explorerName: "Etherscan",
          addressPath: "/address/",
          txPath: "/tx/",
        }),
      },
    },
  },
}));

// Mock Para wallet helpers
vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeWalletSigner: vi.fn().mockResolvedValue({
    getAddress: vi
      .fn()
      .mockResolvedValue("0x1234567890123456789012345678901234567890"),
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "0xtxhash456",
      wait: vi.fn().mockResolvedValue({
        hash: "0xtxhash456",
        blockNumber: 12_346,
        status: 1,
      }),
    }),
  }),
}));

// Mock step handler
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: vi.fn((_input, handler) => handler()),
}));

// Mock utils
vi.mock("@/lib/utils", () => ({
  getErrorMessage: vi.fn((error) => error?.message || String(error)),
}));

import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
// Now import the step functions after all mocks are set up
import { checkBalanceStep } from "@/plugins/web3/steps/check-balance";

// Helper to create test context
const createTestContext = () => ({
  executionId: "exec_123",
  nodeId: "node_123",
  nodeName: "Test Node",
  nodeType: "check-balance" as const,
});

describe("Web3 Plugin Steps Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkBalanceStep", () => {
    it("should successfully check balance on mainnet", async () => {
      const input = {
        network: "mainnet",
        address: "0x1234567890123456789012345678901234567890",
        _context: createTestContext(),
      };

      const result = await checkBalanceStep(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.balance).toBe("5");
        expect(result.balanceWei).toBe("5000000000000000000");
        expect(result.address).toBe(
          "0x1234567890123456789012345678901234567890"
        );
      }

      // Verify getRpcProvider is called with chainId and userId for user RPC preferences
      expect(getRpcProvider).toHaveBeenCalledWith({
        chainId: 1,
        userId: "user_123",
      });
    });

    it("should successfully check balance on sepolia", async () => {
      const input = {
        network: "sepolia",
        address: "0x1234567890123456789012345678901234567890",
        _context: createTestContext(),
      };

      const result = await checkBalanceStep(input);

      expect(result.success).toBe(true);
      expect(getChainIdFromNetwork).toHaveBeenCalledWith("sepolia");
    });

    it("should fail with invalid address", async () => {
      const input = {
        network: "mainnet",
        address: "invalid-address",
        _context: createTestContext(),
      };

      const result = await checkBalanceStep(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid Ethereum address");
      }
    });

    it("should fail with unsupported network", async () => {
      vi.mocked(getChainIdFromNetwork).mockImplementationOnce(() => {
        throw new Error("Unsupported network: polygon");
      });

      const input = {
        network: "polygon",
        address: "0x1234567890123456789012345678901234567890",
        _context: createTestContext(),
      };

      const result = await checkBalanceStep(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Unsupported network");
      }
    });

    it("should handle RPC provider errors", async () => {
      // Mock getRpcProvider to reject (chain not found/disabled)
      vi.mocked(getRpcProvider).mockRejectedValueOnce(
        new Error("Chain 1 not found or not enabled")
      );

      const input = {
        network: "mainnet",
        address: "0x1234567890123456789012345678901234567890",
        _context: createTestContext(),
      };

      const result = await checkBalanceStep(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found or not enabled");
      }
    });

    it("should use user RPC preferences when available", async () => {
      const input = {
        network: "mainnet",
        address: "0x1234567890123456789012345678901234567890",
        _context: createTestContext(),
      };

      const result = await checkBalanceStep(input);

      expect(result.success).toBe(true);
      // Verify getRpcProvider is called with userId so user preferences are resolved
      expect(getRpcProvider).toHaveBeenCalledWith({
        chainId: 1,
        userId: "user_123",
      });
    });
  });
});

describe("Web3 RPC Provider Resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should pass userId to getRpcProvider for user preferences", async () => {
    const result = await checkBalanceStep({
      network: "mainnet",
      address: "0x1234567890123456789012345678901234567890",
      _context: createTestContext(),
    });

    expect(result.success).toBe(true);
    expect(getRpcProvider).toHaveBeenCalledWith({
      chainId: 1,
      userId: "user_123",
    });
  });

  it("should fail when getRpcProvider rejects for disabled chain", async () => {
    vi.mocked(getRpcProvider).mockRejectedValueOnce(
      new Error("Chain 999 not found or not enabled")
    );

    const result = await checkBalanceStep({
      network: "mainnet",
      address: "0x1234567890123456789012345678901234567890",
      _context: createTestContext(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found or not enabled");
    }
  });

  it("should use executeWithFailover for balance check", async () => {
    const mockExecuteWithFailover = vi.fn(
      async (operation: (provider: unknown) => Promise<unknown>) => {
        const mockProvider = {
          getBalance: vi
            .fn()
            .mockResolvedValue(BigInt(3_000_000_000_000_000_000)),
        };
        return await operation(mockProvider);
      }
    );
    vi.mocked(getRpcProvider).mockResolvedValueOnce({
      executeWithFailover: mockExecuteWithFailover,
    } as unknown as Awaited<ReturnType<typeof getRpcProvider>>);

    const result = await checkBalanceStep({
      network: "mainnet",
      address: "0x1234567890123456789012345678901234567890",
      _context: createTestContext(),
    });

    expect(result.success).toBe(true);
    expect(mockExecuteWithFailover).toHaveBeenCalledOnce();
  });
});
