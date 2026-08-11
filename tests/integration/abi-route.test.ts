/**
 * Integration Tests for /api/chains/[chainId]/abi route
 *
 * Tests the ABI fetching API endpoint for different explorer types:
 * - Etherscan (Ethereum mainnet, chain 1)
 * - Basescan via Etherscan v2 (Base, chain 8453)
 * - Blockscout (Tempo testnet, chain 42431)
 * - Solscan (Solana, chain 101) - should return error
 *
 * Run with: pnpm vitest tests/integration/abi-route.test.ts
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock server-only module
vi.mock("server-only", () => ({}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Track db.select() call sequence: first call = chains, second call = explorerConfigs
let selectCallIndex = 0;
let mockChainResult: unknown[] = [];
let mockExplorerResult: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            selectCallIndex += 1;
            if (selectCallIndex === 1) {
              return Promise.resolve(mockChainResult);
            }
            return Promise.resolve(mockExplorerResult);
          }),
        })),
      })),
    })),
  },
}));

// Import route after mocks are set up
import { GET } from "@/app/api/chains/[chainId]/abi/route";

// Test fixtures
const mockChains = {
  ethereum: {
    id: "chain_1",
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    chainType: "evm",
    isEnabled: true,
  },
  base: {
    id: "chain_8453",
    chainId: 8453,
    name: "Base",
    symbol: "ETH",
    chainType: "evm",
    isEnabled: true,
  },
  tempo: {
    id: "chain_42431",
    chainId: 42_431,
    name: "Tempo Testnet",
    symbol: "TEMPO",
    chainType: "evm",
    isEnabled: true,
  },
  solana: {
    id: "chain_101",
    chainId: 101,
    name: "Solana Mainnet",
    symbol: "SOL",
    chainType: "solana",
    isEnabled: true,
  },
};

const mockExplorers = {
  etherscan: {
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
  },
  basescan: {
    id: "explorer_8453",
    chainId: 8453,
    chainType: "evm",
    explorerUrl: "https://basescan.org",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  blockscout: {
    id: "explorer_42431",
    chainId: 42_431,
    chainType: "evm",
    explorerUrl: "https://explore.testnet.tempo.xyz",
    explorerApiType: "blockscout",
    explorerApiUrl: "https://explore.testnet.tempo.xyz/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}?tab=contract",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  solscan: {
    id: "explorer_101",
    chainId: 101,
    chainType: "solana",
    explorerUrl: "https://solscan.io",
    explorerApiType: "solscan",
    explorerApiUrl: "https://api.solscan.io",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/account/{address}",
    explorerContractPath: "/account/{address}#anchorProgramIDL",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

// Helper to create request
function createRequest(chainId: string, address?: string): NextRequest {
  const url = new URL(`http://localhost:3000/api/chains/${chainId}/abi`);
  if (address) {
    url.searchParams.set("address", address);
  }
  return new NextRequest(url);
}

// Helper to set up mocks for a successful chain + explorer lookup
function setupMocks(chain: unknown, explorer: unknown) {
  mockChainResult = chain ? [chain] : [];
  mockExplorerResult = explorer ? [explorer] : [];
}

describe("/api/chains/[chainId]/abi route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    selectCallIndex = 0;
    mockChainResult = [];
    mockExplorerResult = [];
    // Clear environment variable (empty string is falsy, unlike "undefined" string)
    process.env.ETHERSCAN_API_KEY = "";
  });

  describe("Input validation", () => {
    it("should return 400 when address is missing", async () => {
      const request = createRequest("1");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Address query parameter is required");
    });

    it("should return 400 for invalid chainId", async () => {
      const request = createRequest("invalid", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "invalid" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Invalid chain ID");
    });

    it("should return 404 when chain not found", async () => {
      setupMocks(null, null);

      const request = createRequest("999999", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "999999" }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Chain not found");
    });

    it("should return 404 when explorer not configured", async () => {
      setupMocks(mockChains.ethereum, null);

      const request = createRequest("1", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Explorer not configured for this chain");
    });
  });

  describe("Etherscan ABI fetch (chain 1)", () => {
    const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

    it("should fetch ABI successfully with API key", async () => {
      process.env.ETHERSCAN_API_KEY = "test-api-key";

      const mockAbi = [
        { type: "function", name: "transfer", inputs: [], outputs: [] },
        { type: "function", name: "balanceOf", inputs: [], outputs: [] },
      ];

      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const request = createRequest("1", USDT_ADDRESS);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.abi).toEqual(mockAbi);
      expect(data.explorerUrl).toBe(
        `https://etherscan.io/address/${USDT_ADDRESS}#code`
      );

      // Verify fetch was called with correct params
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("chainid=1");
      expect(calledUrl).toContain("apikey=test-api-key");
      expect(calledUrl).toContain(`address=${USDT_ADDRESS}`);
    });

    it("should fetch ABI without API key (rate limited)", async () => {
      const mockAbi = [
        { type: "function", name: "test", inputs: [], outputs: [] },
      ];

      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const request = createRequest("1", USDT_ADDRESS);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify no apikey in URL
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain("apikey");
    });

    it("should return error for unverified contract", async () => {
      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Contract source code not verified",
          }),
      });

      const request = createRequest("1", USDT_ADDRESS);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe(
        "Contract source code is not verified on the block explorer"
      );
      expect(data.explorerUrl).toBe(
        `https://etherscan.io/address/${USDT_ADDRESS}#code`
      );
    });

    it("should return error for invalid API key", async () => {
      process.env.ETHERSCAN_API_KEY = "bad-key";

      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Invalid API Key",
          }),
      });

      const request = createRequest("1", USDT_ADDRESS);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Invalid Etherscan API key");
    });

    it("should return error for rate limit", async () => {
      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      });

      const request = createRequest("1", USDT_ADDRESS);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Rate limit exceeded. Please try again later.");
    });
  });

  describe("Basescan via Etherscan v2 (chain 8453)", () => {
    const BASE_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base

    it("should fetch ABI successfully using Etherscan v2 API", async () => {
      process.env.ETHERSCAN_API_KEY = "test-api-key";

      const mockAbi = [
        { type: "function", name: "transfer", inputs: [], outputs: [] },
      ];

      setupMocks(mockChains.base, mockExplorers.basescan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const request = createRequest("8453", BASE_CONTRACT);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "8453" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.abi).toEqual(mockAbi);
      expect(data.explorerUrl).toBe(
        `https://basescan.org/address/${BASE_CONTRACT}#code`
      );

      // Verify fetch was called with chainid=8453 for Etherscan v2
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("chainid=8453");
      expect(calledUrl).toContain("api.etherscan.io/v2/api");
    });
  });

  describe("Blockscout (chain 42431 - Tempo)", () => {
    const TEMPO_CONTRACT = "0x1234567890123456789012345678901234567890";

    it("should fetch ABI successfully from Blockscout", async () => {
      const mockAbi = [
        { type: "function", name: "deposit", inputs: [], outputs: [] },
        { type: "event", name: "Deposit", inputs: [] },
      ];

      setupMocks(mockChains.tempo, mockExplorers.blockscout);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const request = createRequest("42431", TEMPO_CONTRACT);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "42431" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.abi).toEqual(mockAbi);
      expect(data.explorerUrl).toBe(
        `https://explore.testnet.tempo.xyz/address/${TEMPO_CONTRACT}?tab=contract`
      );

      // Verify Blockscout doesn't use chainid or apikey
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("explore.testnet.tempo.xyz/api");
      expect(calledUrl).not.toContain("chainid");
      expect(calledUrl).not.toContain("apikey");
    });

    it("should return error for unverified contract on Blockscout", async () => {
      setupMocks(mockChains.tempo, mockExplorers.blockscout);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Contract source code not verified",
          }),
      });

      const request = createRequest("42431", TEMPO_CONTRACT);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "42431" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe(
        "Contract source code is not verified on the block explorer"
      );
    });
  });

  describe("Solana (chain 101) - IDL not supported", () => {
    const SOLANA_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    it("should return error for Solana IDL fetch", async () => {
      setupMocks(mockChains.solana, mockExplorers.solscan);

      const request = createRequest("101", SOLANA_PROGRAM);
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "101" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe(
        "Solana IDL fetch not supported via API. Use Anchor CLI instead."
      );
      expect(data.explorerUrl).toBe(
        `https://solscan.io/account/${SOLANA_PROGRAM}#anchorProgramIDL`
      );

      // Verify no fetch was made
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("should handle network errors", async () => {
      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const request = createRequest("1", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Network error");
    });

    it("should handle malformed JSON response", async () => {
      setupMocks(mockChains.ethereum, mockExplorers.etherscan);
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: "not valid json",
          }),
      });

      const request = createRequest("1", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Unexpected token");
    });

    it("should handle explorer with missing API config", async () => {
      setupMocks(mockChains.ethereum, {
        ...mockExplorers.etherscan,
        explorerApiUrl: null,
        explorerApiType: null,
      });

      const request = createRequest("1", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Explorer API not configured for this chain");
    });

    it("should handle unknown explorer type", async () => {
      setupMocks(mockChains.ethereum, {
        ...mockExplorers.etherscan,
        explorerApiType: "unknown",
      });

      const request = createRequest("1", "0x123");
      const response = await GET(request, {
        params: Promise.resolve({ chainId: "1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Unknown explorer type: unknown");
    });
  });
});
