/**
 * Integration Tests for /api/chains route
 *
 * Tests the chains listing API endpoint used by the chain-select component.
 * Verifies:
 * - Only enabled chains are returned by default
 * - includeDisabled=true returns all chains
 * - Response format matches ChainResponse type
 * - Explorer configs are joined correctly
 *
 * Run with: pnpm vitest tests/integration/chains-route.test.ts
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock server-only module
vi.mock("server-only", () => ({}));

// Mock database
let mockQueryResult: unknown[] = [];

// Create a thenable object that also has .where() method
const createQueryBuilder = () => {
  const promise = Promise.resolve(mockQueryResult);
  const queryBuilder = Object.assign(promise, {
    where: vi.fn(() => Promise.resolve(mockQueryResult)),
  });
  return queryBuilder;
};

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => createQueryBuilder()),
      })),
    })),
  },
}));

// Import route after mocks are set up
import { GET } from "@/app/api/chains/route";

// Test fixtures
const mockChains = {
  ethereumWithExplorer: {
    chain: {
      id: "chain_1",
      chainId: 1,
      name: "Ethereum Mainnet",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: "https://eth.example.com",
      defaultFallbackRpc: "https://eth-backup.example.com",
      isTestnet: false,
      isEnabled: true,
    },
    explorer: {
      explorerUrl: "https://etherscan.io",
      explorerApiUrl: "https://api.etherscan.io/v2/api",
      explorerApiType: "etherscan",
    },
  },
  sepoliaWithExplorer: {
    chain: {
      id: "chain_11155111",
      chainId: 11_155_111,
      name: "Sepolia Testnet",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: "https://sepolia.example.com",
      defaultFallbackRpc: null,
      isTestnet: true,
      isEnabled: true,
    },
    explorer: {
      explorerUrl: "https://sepolia.etherscan.io",
      explorerApiUrl: "https://api-sepolia.etherscan.io/v2/api",
      explorerApiType: "etherscan",
    },
  },
  baseWithExplorer: {
    chain: {
      id: "chain_8453",
      chainId: 8453,
      name: "Base",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: "https://base.example.com",
      defaultFallbackRpc: "https://base-backup.example.com",
      isTestnet: false,
      isEnabled: true,
    },
    explorer: {
      explorerUrl: "https://basescan.org",
      explorerApiUrl: "https://api.basescan.org/api",
      explorerApiType: "etherscan",
    },
  },
  tempoDisabled: {
    chain: {
      id: "chain_4217",
      chainId: 4217,
      name: "Tempo",
      symbol: "USD",
      chainType: "evm",
      defaultPrimaryRpc: "https://tempo.example.com",
      defaultFallbackRpc: null,
      isTestnet: false,
      isEnabled: false, // Disabled chain
    },
    explorer: {
      explorerUrl: "https://explorer.tempo.xyz",
      explorerApiUrl: "https://explorer.tempo.xyz/api",
      explorerApiType: "blockscout",
    },
  },
  solanaNoExplorer: {
    chain: {
      id: "chain_101",
      chainId: 101,
      name: "Solana",
      symbol: "SOL",
      chainType: "solana",
      defaultPrimaryRpc: "https://solana.example.com",
      defaultFallbackRpc: null,
      isTestnet: false,
      isEnabled: true,
    },
    explorer: null, // No explorer config
  },
};

// Helper to create a mock request
function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("/api/chains route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryResult = [];
  });

  describe("GET /api/chains", () => {
    it("should return only enabled chains by default", async () => {
      // Setup: Return enabled chains only
      mockQueryResult = [
        mockChains.ethereumWithExplorer,
        mockChains.sepoliaWithExplorer,
        mockChains.baseWithExplorer,
        mockChains.solanaNoExplorer,
      ];

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveLength(4);

      // Verify all returned chains are enabled
      for (const chain of data) {
        expect(chain.isEnabled).toBe(true);
      }
    });

    it("should return all chains when includeDisabled=true", async () => {
      // Setup: Return all chains including disabled
      mockQueryResult = [
        mockChains.ethereumWithExplorer,
        mockChains.sepoliaWithExplorer,
        mockChains.baseWithExplorer,
        mockChains.tempoDisabled,
        mockChains.solanaNoExplorer,
      ];

      const request = createRequest("/api/chains?includeDisabled=true");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveLength(5);

      // Verify disabled chain is included
      const tempoChain = data.find(
        (c: { chainId: number }) => c.chainId === 4217
      );
      expect(tempoChain).toBeDefined();
      expect(tempoChain.isEnabled).toBe(false);
    });

    it("should return correct response format for ChainResponse", async () => {
      mockQueryResult = [mockChains.ethereumWithExplorer];

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveLength(1);

      const chain = data[0];
      // Verify all expected fields are present
      expect(chain).toHaveProperty("id", "chain_1");
      expect(chain).toHaveProperty("chainId", 1);
      expect(chain).toHaveProperty("name", "Ethereum Mainnet");
      expect(chain).toHaveProperty("symbol", "ETH");
      expect(chain).toHaveProperty("chainType", "evm");
      // SECURITY: defaultPrimaryRpc / defaultFallbackRpc must NOT be returned
      // by the public endpoint (some entries embed provider API keys).
      expect(chain).not.toHaveProperty("defaultPrimaryRpc");
      expect(chain).not.toHaveProperty("defaultFallbackRpc");
      expect(chain).toHaveProperty("explorerUrl", "https://etherscan.io");
      expect(chain).toHaveProperty(
        "explorerApiUrl",
        "https://api.etherscan.io/v2/api"
      );
      expect(chain).toHaveProperty("explorerApiType", "etherscan");
      expect(chain).toHaveProperty("isTestnet", false);
      expect(chain).toHaveProperty("isEnabled", true);
    });

    it("should handle chains without explorer config", async () => {
      mockQueryResult = [mockChains.solanaNoExplorer];

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveLength(1);

      const chain = data[0];
      expect(chain.chainId).toBe(101);
      expect(chain.name).toBe("Solana");
      // Explorer fields should be null when no explorer config
      expect(chain.explorerUrl).toBeNull();
      expect(chain.explorerApiUrl).toBeNull();
      expect(chain.explorerApiType).toBeNull();
    });

    it("should return empty array when no chains exist", async () => {
      mockQueryResult = [];

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual([]);
    });

    it("should separate mainnets and testnets correctly", async () => {
      mockQueryResult = [
        mockChains.ethereumWithExplorer, // mainnet
        mockChains.sepoliaWithExplorer, // testnet
        mockChains.baseWithExplorer, // mainnet
      ];

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);

      const mainnets = data.filter((c: { isTestnet: boolean }) => !c.isTestnet);
      const testnets = data.filter((c: { isTestnet: boolean }) => c.isTestnet);

      expect(mainnets).toHaveLength(2);
      expect(testnets).toHaveLength(1);
      expect(testnets[0].name).toBe("Sepolia Testnet");
    });

    it("should support filtering by chain type for frontend", async () => {
      // This test verifies the data can be filtered by chainType on the client
      mockQueryResult = [
        mockChains.ethereumWithExplorer,
        mockChains.baseWithExplorer,
        mockChains.solanaNoExplorer,
      ];

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);

      // Frontend can filter by chainType
      const evmChains = data.filter(
        (c: { chainType: string }) => c.chainType === "evm"
      );
      const solanaChains = data.filter(
        (c: { chainType: string }) => c.chainType === "solana"
      );

      expect(evmChains).toHaveLength(2);
      expect(solanaChains).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    it("should return 500 on database error", async () => {
      // Mock a database error
      const { db } = await import("@/lib/db");
      vi.mocked(db.select).mockImplementationOnce(() => {
        throw new Error("Database connection failed");
      });

      const request = createRequest("/api/chains");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toHaveProperty("error", "Failed to get chains");
      expect(data).toHaveProperty("details");
    });
  });
});
