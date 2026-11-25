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

const { mockRpcEvm } = vi.hoisted(() => ({ mockRpcEvm: vi.fn() }));

vi.mock("@/lib/rpc/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rpc/engine")>()),
  rpc: { evm: mockRpcEvm, solana: vi.fn(), route: vi.fn() },
}));

function clientWithBalance(wei: bigint): {
  manager: { executeWithFailover: ReturnType<typeof vi.fn> };
} {
  return {
    manager: {
      executeWithFailover: vi.fn(
        async (operation: (provider: unknown) => Promise<unknown>) =>
          await operation({ getBalance: vi.fn().mockResolvedValue(wei) })
      ),
    },
  };
}

// Mock database
vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: () => Promise.resolve("member"),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { userId: "user_123", executionOrganizationId: "org_123" },
              ]),
          }),
        }),
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
  runPluginStep: vi.fn((_options, input, handler) => handler(input)),
  withStepLogging: vi.fn((_input, handler) => handler()),
}));

// Mock utils
vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    getErrorMessage: vi.fn((error) => error?.message || String(error)),
  };
});

import { RpcPurpose, RpcScopeKind } from "@/lib/rpc/engine";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
// Now import the step functions after all mocks are set up
import { checkBalanceStep } from "@/plugins/web3/steps/check-balance";

// Helper to create test context
const ORG_ID = "org_123";

const createTestContext = () => ({
  executionId: "exec_123",
  organizationId: ORG_ID,
  nodeId: "node_123",
  nodeName: "Test Node",
  nodeType: "check-balance" as const,
});

describe("Web3 Plugin Steps Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcEvm.mockResolvedValue(
      clientWithBalance(BigInt(5_000_000_000_000_000_000))
    );
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

      expect(mockRpcEvm).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: RpcScopeKind.ORG,
          organizationId: ORG_ID,
        }),
        1,
        { purpose: RpcPurpose.READ }
      );
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
      mockRpcEvm.mockRejectedValueOnce(
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
  });
});

describe("Web3 RPC Provider Resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcEvm.mockResolvedValue(
      clientWithBalance(BigInt(5_000_000_000_000_000_000))
    );
  });

  it("resolves the route from the step's organization", async () => {
    const result = await checkBalanceStep({
      network: "mainnet",
      address: "0x1234567890123456789012345678901234567890",
      _context: createTestContext(),
    });

    expect(result.success).toBe(true);
    expect(mockRpcEvm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: RpcScopeKind.ORG,
        organizationId: ORG_ID,
      }),
      1,
      { purpose: RpcPurpose.READ }
    );
  });

  it("should fail when the route cannot be resolved for a disabled chain", async () => {
    mockRpcEvm.mockRejectedValueOnce(
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
    const client = clientWithBalance(BigInt(3_000_000_000_000_000_000));
    mockRpcEvm.mockResolvedValueOnce(client);

    const result = await checkBalanceStep({
      network: "mainnet",
      address: "0x1234567890123456789012345678901234567890",
      _context: createTestContext(),
    });

    expect(result.success).toBe(true);
    expect(client.manager.executeWithFailover).toHaveBeenCalledOnce();
  });
});
