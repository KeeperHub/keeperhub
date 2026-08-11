import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExplorerConfig } from "@/lib/db/schema";
import {
  fetchContractAbi,
  getAddressUrl,
  getContractUrl,
  getTransactionUrl,
} from "@/lib/explorer";
import {
  type BlockscoutTransaction,
  fetchBlockscoutAbi,
  fetchBlockscoutTransactions,
} from "@/lib/explorer/blockscout";
import {
  type EtherscanTransaction,
  fetchEtherscanAbi,
  fetchEtherscanTransactions,
} from "@/lib/explorer/etherscan";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("explorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Base mock explorer configs
  const baseEvmConfig: ExplorerConfig = {
    id: "explorer_1",
    chainId: 1,
    chainType: "evm",
    explorerUrl: "https://etherscan.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
    backupExplorerApiType: null,
    backupExplorerApiUrl: null,
    backupExplorerApiKeyNeeded: false,
    backupExplorerApiKey: null,
    backupExplorerUrl: null,
    backupExplorerTxPath: null,
    backupExplorerAddressPath: null,
    backupExplorerContractPath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const blockscoutConfig: ExplorerConfig = {
    id: "explorer_2",
    chainId: 42_431,
    chainType: "evm",
    explorerUrl: "https://explore.testnet.tempo.xyz",
    explorerApiType: "blockscout",
    explorerApiUrl: "https://explore.testnet.tempo.xyz/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}?tab=contract",
    backupExplorerApiType: null,
    backupExplorerApiUrl: null,
    backupExplorerApiKeyNeeded: false,
    backupExplorerApiKey: null,
    backupExplorerUrl: null,
    backupExplorerTxPath: null,
    backupExplorerAddressPath: null,
    backupExplorerContractPath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const solanaConfig: ExplorerConfig = {
    id: "explorer_3",
    chainId: 101,
    chainType: "solana",
    explorerUrl: "https://solscan.io",
    explorerApiType: "solscan",
    explorerApiUrl: "https://api.solscan.io",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/account/{address}",
    explorerContractPath: "/account/{address}#anchorProgramIDL",
    backupExplorerApiType: null,
    backupExplorerApiUrl: null,
    backupExplorerApiKeyNeeded: false,
    backupExplorerApiKey: null,
    backupExplorerUrl: null,
    backupExplorerTxPath: null,
    backupExplorerAddressPath: null,
    backupExplorerContractPath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("getTransactionUrl", () => {
    it("should build transaction URL for EVM chain", () => {
      const txHash =
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const url = getTransactionUrl(baseEvmConfig, txHash);

      expect(url).toBe(`https://etherscan.io/tx/${txHash}`);
    });

    it("should build transaction URL for Blockscout", () => {
      const txHash = "0xabc123";
      const url = getTransactionUrl(blockscoutConfig, txHash);

      expect(url).toBe(`https://explore.testnet.tempo.xyz/tx/${txHash}`);
    });

    it("should build transaction URL for Solana", () => {
      const txHash = "5Yfx...signature";
      const url = getTransactionUrl(solanaConfig, txHash);

      expect(url).toBe(`https://solscan.io/tx/${txHash}`);
    });

    it("should return empty string when explorerUrl is null", () => {
      const config = { ...baseEvmConfig, explorerUrl: null };
      const url = getTransactionUrl(config, "0x123");

      expect(url).toBe("");
    });

    it("should use default path when explorerTxPath is null", () => {
      const config = { ...baseEvmConfig, explorerTxPath: null };
      const url = getTransactionUrl(config, "0x123");

      expect(url).toBe("https://etherscan.io/tx/0x123");
    });
  });

  describe("getAddressUrl", () => {
    it("should build address URL for EVM chain", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const url = getAddressUrl(baseEvmConfig, address);

      expect(url).toBe(`https://etherscan.io/address/${address}`);
    });

    it("should build address URL for Solana with /account path", () => {
      const address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const url = getAddressUrl(solanaConfig, address);

      expect(url).toBe(`https://solscan.io/account/${address}`);
    });

    it("should return empty string when explorerUrl is null", () => {
      const config = { ...baseEvmConfig, explorerUrl: null };
      const url = getAddressUrl(config, "0x123");

      expect(url).toBe("");
    });

    it("should use default path when explorerAddressPath is null", () => {
      const config = { ...baseEvmConfig, explorerAddressPath: null };
      const url = getAddressUrl(config, "0x123");

      expect(url).toBe("https://etherscan.io/address/0x123");
    });
  });

  describe("getContractUrl", () => {
    it("should build contract URL for Etherscan with #code fragment", () => {
      const address = "0x1234567890123456789012345678901234567890";
      const url = getContractUrl(baseEvmConfig, address);

      expect(url).toBe(`https://etherscan.io/address/${address}#code`);
    });

    it("should build contract URL for Blockscout with ?tab=contract query", () => {
      const address = "0xabc123";
      const url = getContractUrl(blockscoutConfig, address);

      expect(url).toBe(
        `https://explore.testnet.tempo.xyz/address/${address}?tab=contract`
      );
    });

    it("should build contract URL for Solana with #anchorProgramIDL fragment", () => {
      const address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const url = getContractUrl(solanaConfig, address);

      expect(url).toBe(
        `https://solscan.io/account/${address}#anchorProgramIDL`
      );
    });

    it("should return empty string when explorerUrl is null", () => {
      const config = { ...baseEvmConfig, explorerUrl: null };
      const url = getContractUrl(config, "0x123");

      expect(url).toBe("");
    });

    it("should fall back to /address/{address}#code for EVM when explorerContractPath is null", () => {
      const config = { ...baseEvmConfig, explorerContractPath: null };
      const url = getContractUrl(config, "0x123");

      expect(url).toBe("https://etherscan.io/address/0x123#code");
    });

    it("should fall back to /account/{address}#anchorProgramIDL for Solana when explorerContractPath is null", () => {
      const config = { ...solanaConfig, explorerContractPath: null };
      const url = getContractUrl(config, "0x123");

      expect(url).toBe("https://solscan.io/account/0x123#anchorProgramIDL");
    });
  });

  describe("fetchContractAbi dispatcher", () => {
    it("should return error when explorerApiUrl is null", async () => {
      const config = { ...baseEvmConfig, explorerApiUrl: null };
      const result = await fetchContractAbi(config, "0x123", 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Explorer API not configured for this chain");
    });

    it("should return error when explorerApiType is null", async () => {
      const config = { ...baseEvmConfig, explorerApiType: null };
      const result = await fetchContractAbi(config, "0x123", 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Explorer API not configured for this chain");
    });

    it("should return error for solscan type (IDL not supported)", async () => {
      const result = await fetchContractAbi(solanaConfig, "0x123", 101);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Solana IDL fetch not supported via API. Use Anchor CLI instead."
      );
    });

    it("should return error for unknown explorer type", async () => {
      const config = {
        ...baseEvmConfig,
        explorerApiType: "unknown",
      };
      const result = await fetchContractAbi(config, "0x123", 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown explorer type: unknown");
    });

    it("should call fetchEtherscanAbi for etherscan type", async () => {
      const mockAbi = [{ type: "function", name: "test" }];
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const result = await fetchContractAbi(
        baseEvmConfig,
        "0x123",
        1,
        "test-key"
      );

      expect(result.success).toBe(true);
      expect(result.abi).toEqual(mockAbi);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("https://api.etherscan.io/v2/api")
      );
    });

    it("should call fetchBlockscoutAbi for blockscout type", async () => {
      const mockAbi = [{ type: "function", name: "test" }];
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const result = await fetchContractAbi(blockscoutConfig, "0x123", 42_431);

      expect(result.success).toBe(true);
      expect(result.abi).toEqual(mockAbi);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("https://explore.testnet.tempo.xyz/api")
      );
    });
  });

  describe("fetchEtherscanAbi", () => {
    const apiUrl = "https://api.etherscan.io/v2/api";
    const contractAddress = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const chainId = 1;

    it("should return ABI on successful response", async () => {
      const mockAbi = [
        { type: "function", name: "transfer", inputs: [], outputs: [] },
      ];
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const result = await fetchEtherscanAbi(
        apiUrl,
        chainId,
        contractAddress,
        "test-key"
      );

      expect(result.success).toBe(true);
      expect(result.abi).toEqual(mockAbi);
    });

    it("should include chainid and apikey in request", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: "[]",
          }),
      });

      await fetchEtherscanAbi(apiUrl, chainId, contractAddress, "my-api-key");

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("chainid=1");
      expect(calledUrl).toContain("apikey=my-api-key");
      expect(calledUrl).toContain("module=contract");
      expect(calledUrl).toContain("action=getabi");
      expect(calledUrl).toContain(`address=${contractAddress}`);
    });

    it("should not include apikey when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: "[]",
          }),
      });

      await fetchEtherscanAbi(apiUrl, chainId, contractAddress);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain("apikey");
    });

    it("should return error for unverified contract", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Contract source code not verified",
          }),
      });

      const result = await fetchEtherscanAbi(apiUrl, chainId, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Contract source code is not verified on the block explorer"
      );
    });

    it("should return error for invalid API key", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Invalid API Key",
          }),
      });

      const result = await fetchEtherscanAbi(
        apiUrl,
        chainId,
        contractAddress,
        "bad-key"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid Etherscan API key");
    });

    it("should return error for rate limit", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      });

      const result = await fetchEtherscanAbi(apiUrl, chainId, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Rate limit exceeded. Please try again later.");
    });

    it("should return error for invalid address", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Invalid address format",
          }),
      });

      const result = await fetchEtherscanAbi(apiUrl, chainId, "invalid");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid contract address");
    });

    it("should return error for network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await fetchEtherscanAbi(apiUrl, chainId, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("should return error for JSON parse failure", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: "not valid json",
          }),
      });

      const result = await fetchEtherscanAbi(apiUrl, chainId, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unexpected token");
    });

    it("should return raw error message for unknown error", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Some random error from API",
          }),
      });

      const result = await fetchEtherscanAbi(apiUrl, chainId, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Some random error from API");
    });
  });

  describe("fetchBlockscoutAbi", () => {
    const apiUrl = "https://explore.testnet.tempo.xyz/api";
    const contractAddress = "0x1234567890123456789012345678901234567890";

    it("should return ABI on successful response", async () => {
      const mockAbi = [
        { type: "function", name: "deposit", inputs: [], outputs: [] },
      ];
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: JSON.stringify(mockAbi),
          }),
      });

      const result = await fetchBlockscoutAbi(apiUrl, contractAddress);

      expect(result.success).toBe(true);
      expect(result.abi).toEqual(mockAbi);
    });

    it("should include correct parameters in request", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: "[]",
          }),
      });

      await fetchBlockscoutAbi(apiUrl, contractAddress);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("module=contract");
      expect(calledUrl).toContain("action=getabi");
      expect(calledUrl).toContain(`address=${contractAddress}`);
      // Blockscout doesn't use chainid or apikey
      expect(calledUrl).not.toContain("chainid");
      expect(calledUrl).not.toContain("apikey");
    });

    it("should return error for unverified contract", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Contract source code not verified",
          }),
      });

      const result = await fetchBlockscoutAbi(apiUrl, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Contract source code is not verified on the block explorer"
      );
    });

    it("should return error for invalid address", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Invalid address",
          }),
      });

      const result = await fetchBlockscoutAbi(apiUrl, "invalid");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid contract address");
    });

    it("should return error for network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await fetchBlockscoutAbi(apiUrl, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection refused");
    });

    it("should return error for JSON parse failure", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "1",
            message: "OK",
            result: "{invalid json",
          }),
      });

      const result = await fetchBlockscoutAbi(apiUrl, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Expected");
    });

    it("should return raw error message for unknown error", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Unknown Blockscout error",
          }),
      });

      const result = await fetchBlockscoutAbi(apiUrl, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown Blockscout error");
    });

    it("should return default error when result is empty", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "",
            result: "",
          }),
      });

      const result = await fetchBlockscoutAbi(apiUrl, contractAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to fetch ABI from Blockscout");
    });
  });

  describe("fetchEtherscanTransactions", () => {
    const apiUrl = "https://api.etherscan.io/v2/api";
    const chainId = 1;
    const contractAddress = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const startBlock = 100;
    const endBlock = 999_999;

    function createEtherscanTxResponse(
      transactions: Partial<EtherscanTransaction>[],
      status = "1"
    ): {
      status: string;
      message: string;
      result: EtherscanTransaction[];
    } {
      return {
        status,
        message: status === "1" ? "OK" : "NOTOK",
        result: transactions.map((tx) => ({
          hash: tx.hash ?? "0xtx1",
          from: tx.from ?? "0xsender",
          to: tx.to ?? "0xcontract",
          value: tx.value ?? "0",
          input: tx.input ?? "0x",
          blockNumber: tx.blockNumber ?? "100",
          timeStamp: tx.timeStamp ?? "1700000000",
          isError: tx.isError ?? "0",
          functionName: tx.functionName ?? "transfer(address,uint256)",
        })),
      };
    }

    function mockFetchJsonResponse(data: unknown): {
      ok: boolean;
      json: () => Promise<unknown>;
    } {
      return { ok: true, json: async () => data };
    }

    it("should return transactions for a single page of results", async () => {
      const txs = [
        { hash: "0xaaa", blockNumber: "200" },
        { hash: "0xbbb", blockNumber: "300" },
      ];
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse(txs))
      );

      const result = await fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].hash).toBe("0xaaa");
        expect(result.transactions[1].hash).toBe("0xbbb");
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should walk the block cursor when a window returns a full offset", async () => {
      vi.useFakeTimers();

      // First window fills the 10,000 cap, spanning blocks 100..10099.
      const fullWindow = Array.from({ length: 10_000 }, (_, i) => ({
        hash: `0xfull${i}`,
        blockNumber: String(startBlock + i),
      }));
      // Second window resumes from the highest block seen (10099): the overlap
      // tx is de-duplicated, the two newer ones are kept.
      const secondWindow = [
        { hash: "0xfull9999", blockNumber: "10099" },
        { hash: "0xnew1", blockNumber: "10099" },
        { hash: "0xnew2", blockNumber: "10100" },
      ];

      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse(fullWindow))
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse(secondWindow))
      );

      const resultPromise = fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(250);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(10_002);
        expect(result.transactions.at(-2)?.hash).toBe("0xnew1");
        expect(result.transactions.at(-1)?.hash).toBe("0xnew2");
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second request resumes from the highest block of the first window.
      const secondCallUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondCallUrl).toContain("startblock=10099");

      vi.useRealTimers();
    });

    it("should stop and keep collected results when the window is exhausted", async () => {
      vi.useFakeTimers();

      const fullWindow = Array.from({ length: 10_000 }, (_, i) => ({
        hash: `0xwin${i}`,
        blockNumber: String(startBlock + i),
      }));

      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse(fullWindow))
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse({
          status: "0",
          message:
            "Result window is too large, PageNo x Offset size must be less than or equal to 10000",
          result: null,
        })
      );

      const resultPromise = fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(250);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(10_000);
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("should return empty array for 'no transactions found' message", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse({
          status: "0",
          message: "No transactions found",
          result: "No transactions found",
        })
      );

      const result = await fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toEqual([]);
      }
    });

    it("should propagate API error message on failure", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse({
          status: "0",
          message: "NOTOK",
          result: "Rate limit exceeded",
        })
      );

      const result = await fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          "Rate limit exceeded. Please try again later."
        );
      }
    });

    it("should stop at the window budget even if windows keep filling", async () => {
      vi.useFakeTimers();

      const fullWindow = Array.from({ length: 10_000 }, (_, i) => ({
        hash: `0xpage${i}`,
        blockNumber: String(startBlock + i),
      }));

      // Every window comes back full, so the cursor keeps advancing until the
      // request budget (MAX_TX_WINDOWS = 30) caps it.
      mockFetch.mockResolvedValue(
        mockFetchJsonResponse(createEtherscanTxResponse(fullWindow))
      );

      const resultPromise = fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      for (let d = 0; d < 30; d++) {
        await vi.advanceTimersByTimeAsync(250);
      }

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(30);

      vi.useRealTimers();
    });

    it("should delay between pages using setTimeout", async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const fullPage = Array.from({ length: 10_000 }, (_, i) => ({
        hash: `0xdelay${i}`,
        blockNumber: String(startBlock + i),
      }));
      const lastPage = [{ hash: "0xfinal", blockNumber: "50000" }];

      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse(fullPage))
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse(lastPage))
      );

      const resultPromise = fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(250);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Verify setTimeout was called with the expected delay (220ms)
      const delayCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 220);
      expect(delayCall).toBeDefined();

      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should propagate network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      const result = await fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Network timeout");
      }
    });

    it("should include correct URL parameters", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJsonResponse(createEtherscanTxResponse([{ hash: "0xparams" }]))
      );

      await fetchEtherscanTransactions(
        apiUrl,
        chainId,
        contractAddress,
        startBlock,
        endBlock,
        "my-key"
      );

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("chainid=1");
      expect(calledUrl).toContain("module=account");
      expect(calledUrl).toContain("action=txlist");
      expect(calledUrl).toContain(`address=${contractAddress}`);
      expect(calledUrl).toContain(`startblock=${startBlock}`);
      expect(calledUrl).toContain(`endblock=${endBlock}`);
      expect(calledUrl).toContain("page=1");
      expect(calledUrl).toContain("offset=10000");
      expect(calledUrl).toContain("sort=asc");
      expect(calledUrl).toContain("apikey=my-key");
    });
  });

  describe("fetchBlockscoutTransactions", () => {
    const apiUrl = "https://explore.testnet.tempo.xyz/api";
    const contractAddress = "0x1234567890123456789012345678901234567890";
    const startBlock = 100;
    const endBlock = 500;

    function createBlockscoutTxResponse(
      items: Partial<BlockscoutTransaction>[],
      nextPageParams: { block_number: number; index: number } | null = null
    ): {
      items: BlockscoutTransaction[];
      next_page_params: { block_number: number; index: number } | null;
    } {
      return {
        items: items.map((tx) => ({
          hash: tx.hash ?? "0xtx1",
          from: tx.from ?? { hash: "0xsender" },
          to: tx.to === undefined ? { hash: "0xcontract" } : tx.to,
          value: tx.value ?? "0",
          raw_input: tx.raw_input ?? "0x",
          block: tx.block ?? 100,
          timestamp: tx.timestamp ?? "2024-01-01T00:00:00Z",
          status: tx.status ?? "ok",
          method: tx.method ?? "transfer",
        })),
        next_page_params: nextPageParams,
      };
    }

    function mockFetchOkResponse(data: unknown): {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    } {
      return { ok: true, status: 200, json: async () => data };
    }

    it("should return transactions for a single page within block range", async () => {
      const txs = [
        { hash: "0xaaa", block: 200 },
        { hash: "0xbbb", block: 300 },
      ];
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(createBlockscoutTxResponse(txs))
      );

      const result = await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].hash).toBe("0xaaa");
        expect(result.transactions[1].hash).toBe("0xbbb");
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should paginate using cursor-based pagination", async () => {
      vi.useFakeTimers();

      const firstPageItems = Array.from({ length: 50 }, (_, i) => ({
        hash: `0xfirst${i}`,
        block: 400 - i,
      }));
      const secondPageItems = [
        { hash: "0xsecond1", block: 200 },
        { hash: "0xsecond2", block: 150 },
      ];

      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(
          createBlockscoutTxResponse(firstPageItems, {
            block_number: 350,
            index: 1,
          })
        )
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(createBlockscoutTxResponse(secondPageItems))
      );

      const resultPromise = fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(150);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(52);
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify cursor params in the second call
      const secondCallUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondCallUrl).toContain("block_number=350");
      expect(secondCallUrl).toContain("index=1");

      vi.useRealTimers();
    });

    it("should filter out transactions outside startBlock/endBlock range", async () => {
      const txs = [
        { hash: "0xinrange", block: 200 },
        { hash: "0xbelowstart", block: 50 },
        { hash: "0xaboveend", block: 600 },
        { hash: "0xatstart", block: 100 },
        { hash: "0xatend", block: 500 },
      ];
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(createBlockscoutTxResponse(txs))
      );

      const result = await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(3);
        const hashes = result.transactions.map((tx) => tx.hash);
        expect(hashes).toContain("0xinrange");
        expect(hashes).toContain("0xatstart");
        expect(hashes).toContain("0xatend");
        expect(hashes).not.toContain("0xbelowstart");
        expect(hashes).not.toContain("0xaboveend");
      }
    });

    it("should stop paginating when last block < startBlock", async () => {
      vi.useFakeTimers();

      // First page: 50 items, last block is below startBlock
      const firstPageItems = Array.from({ length: 50 }, (_, i) => ({
        hash: `0xitem${i}`,
        block: 200 - i * 4,
      }));
      // The last item on this page has block = 200 - 49*4 = 4, which is < startBlock (100)

      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(
          createBlockscoutTxResponse(firstPageItems, {
            block_number: 4,
            index: 0,
          })
        )
      );

      const resultPromise = fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(150);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Should NOT make a second request since the last block (4) < startBlock (100)
      expect(mockFetch).toHaveBeenCalledTimes(1);

      if (result.success) {
        // Only items within the range should be collected
        for (const tx of result.transactions) {
          expect(tx.block).toBeGreaterThanOrEqual(startBlock);
          expect(tx.block).toBeLessThanOrEqual(endBlock);
        }
      }

      vi.useRealTimers();
    });

    it("should return error for non-200 API response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      const result = await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Blockscout API returned status 500");
      }
    });

    it("should handle null 'to' field in BlockscoutTransaction", async () => {
      const txs = [{ hash: "0xnullto", block: 200, to: null }];
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(createBlockscoutTxResponse(txs))
      );

      const result = await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].to).toBeNull();
        expect(result.transactions[0].hash).toBe("0xnullto");
      }
    });

    it("should skip pages entirely above endBlock without collecting items", async () => {
      vi.useFakeTimers();

      // First page: all items have block > endBlock (500)
      const abovePage = Array.from({ length: 50 }, (_, i) => ({
        hash: `0xabove${i}`,
        block: 1000 - i,
      }));
      // Lowest block on page is 1000 - 49 = 951, which is > endBlock (500)

      // Second page: items within the range
      const inRangePage = [
        { hash: "0xinrange1", block: 400 },
        { hash: "0xinrange2", block: 300 },
      ];

      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(
          createBlockscoutTxResponse(abovePage, {
            block_number: 951,
            index: 0,
          })
        )
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(createBlockscoutTxResponse(inRangePage))
      );

      const resultPromise = fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(150);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      if (result.success) {
        // None of the above-range items should be collected
        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].hash).toBe("0xinrange1");
        expect(result.transactions[1].hash).toBe("0xinrange2");
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("should delay between pagination requests using setTimeout", async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const firstPageItems = Array.from({ length: 50 }, (_, i) => ({
        hash: `0xdelay${i}`,
        block: 400 - i,
      }));
      const secondPageItems = [{ hash: "0xfinal", block: 200 }];

      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(
          createBlockscoutTxResponse(firstPageItems, {
            block_number: 350,
            index: 1,
          })
        )
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(createBlockscoutTxResponse(secondPageItems))
      );

      const resultPromise = fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      await vi.advanceTimersByTimeAsync(150);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Verify setTimeout was called with the expected delay (100ms)
      const delayCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 100);
      expect(delayCall).toBeDefined();

      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should replace /api suffix with /api/v2 in the URL", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchOkResponse(
          createBlockscoutTxResponse([{ hash: "0xurl", block: 200 }])
        )
      );

      await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain(
        "https://explore.testnet.tempo.xyz/api/v2/addresses/"
      );
      expect(calledUrl).toContain(contractAddress);
      expect(calledUrl).toContain("filter=to");
    });

    it("should propagate network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await fetchBlockscoutTransactions(
        apiUrl,
        contractAddress,
        startBlock,
        endBlock
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Connection refused");
      }
    });
  });
});
