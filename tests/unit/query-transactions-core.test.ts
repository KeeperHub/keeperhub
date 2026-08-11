import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

const mockDbSelect = vi.fn();
const mockFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    query: {
      explorerConfigs: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  explorerConfigs: { chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

const mockGetChainIdFromNetwork = vi.fn();
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

const mockExecuteWithFailover = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: () =>
    Promise.resolve({ executeWithFailover: mockExecuteWithFailover }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { queryTransactionsCore } from "@/plugins/web3/steps/query-transactions-core";

const CONTRACT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const MINIMAL_ABI = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

const BASE_INPUT = {
  network: "ethereum",
  contractAddress: CONTRACT_ADDRESS,
  abi: MINIMAL_ABI,
  abiFunction: "transfer",
  fromBlock: "100",
  toBlock: "200",
};

function makeEtherscanTxResponse(
  transactions: Array<{
    hash: string;
    from?: string;
    to?: string;
    input?: string;
    blockNumber?: string;
  }>,
  status = "1"
): unknown {
  return {
    status,
    message: status === "1" ? "OK" : "NOTOK",
    result: transactions.map((tx) => ({
      hash: tx.hash,
      from: tx.from ?? "0xsender",
      to: tx.to ?? CONTRACT_ADDRESS,
      value: "0",
      input:
        tx.input ??
        "0xa9059cbb000000000000000000000000ab8483f64d9c6d1ecf9b849ae677dd3315835cb2000000000000000000000000000000000000000000000000000000000000000a",
      blockNumber: tx.blockNumber ?? "150",
      timeStamp: "1700000000",
      isError: "0",
      functionName: "transfer(address,uint256)",
    })),
  };
}

describe("queryTransactionsCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetChainIdFromNetwork.mockReturnValue(1);
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    });
    mockExecuteWithFailover.mockImplementation(
      (fn: (p: { getBlockNumber: () => Promise<number> }) => unknown) =>
        fn({ getBlockNumber: () => Promise.resolve(200) })
    );
  });

  describe("validation", () => {
    it("returns error for invalid contract address", async () => {
      const result = await queryTransactionsCore({
        ...BASE_INPUT,
        contractAddress: "not-an-address",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid contract address");
      }
    });

    it("returns error for invalid ABI JSON", async () => {
      const result = await queryTransactionsCore({
        ...BASE_INPUT,
        abi: "not-json",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid ABI JSON");
      }
    });

    it("returns error when function not found in ABI", async () => {
      const result = await queryTransactionsCore({
        ...BASE_INPUT,
        abiFunction: "nonexistentFunction",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("nonexistentFunction");
      }
    });

    it("returns error when no explorer config found for chain", async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No explorer configuration found");
      }
    });
  });

  describe("successful transaction fetch", () => {
    it("returns matched transactions when primary explorer succeeds", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
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
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve(makeEtherscanTxResponse([{ hash: "0xabc" }])),
      });

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.matchCount).toBe(1);
        expect(result.transactions[0].hash).toBe("0xabc");
        expect(result.transactions[0].functionName).toBe("transfer");
      }
    });

    it("returns empty results when no transactions match the function", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
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
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "No transactions found",
            result: "No transactions found",
          }),
      });

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.matchCount).toBe(0);
        expect(result.transactions).toEqual([]);
      }
    });
  });

  describe("backup explorer fallback", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("falls back to backup explorer when primary fails", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
        backupExplorerApiType: "blockscout",
        backupExplorerApiUrl: "https://backup.blockscout.io/api",
        backupExplorerApiKeyNeeded: false,
        backupExplorerApiKey: null,
        backupExplorerUrl: "https://backup.blockscout.io",
        backupExplorerTxPath: "/tx/{hash}",
        backupExplorerAddressPath: "/address/{address}",
        backupExplorerContractPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Primary Etherscan call fails
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      });

      // Backup Blockscout call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            items: [
              {
                hash: "0xfallback",
                from: { hash: "0xsender" },
                to: { hash: CONTRACT_ADDRESS },
                value: "0",
                raw_input:
                  "0xa9059cbb000000000000000000000000ab8483f64d9c6d1ecf9b849ae677dd3315835cb2000000000000000000000000000000000000000000000000000000000000000a",
                block: 150,
                timestamp: "2024-01-01T00:00:00Z",
                status: "ok",
                method: "transfer",
              },
            ],
            next_page_params: null,
          }),
      });

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.matchCount).toBe(1);
        expect(result.transactions[0].hash).toBe("0xfallback");
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns combined error when both providers fail on all rounds", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
        backupExplorerApiType: "etherscan",
        backupExplorerApiUrl: "https://backup.etherscan.io/v2/api",
        backupExplorerApiKeyNeeded: false,
        backupExplorerApiKey: null,
        backupExplorerUrl: null,
        backupExplorerTxPath: null,
        backupExplorerAddressPath: null,
        backupExplorerContractPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const rateLimitResponse = {
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      };
      const unavailableResponse = {
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Service unavailable",
          }),
      };

      // round 1
      mockFetch.mockResolvedValueOnce(rateLimitResponse);
      mockFetch.mockResolvedValueOnce(unavailableResponse);
      // round 2 (after 10s backoff)
      mockFetch.mockResolvedValueOnce(rateLimitResponse);
      mockFetch.mockResolvedValueOnce(unavailableResponse);

      const resultPromise = queryTransactionsCore(BASE_INPUT);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("All explorer providers failed");
        expect(result.error).toContain("Primary:");
        expect(result.error).toContain("Backup:");
      }
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("self-heals when both providers fail transiently then primary succeeds on retry", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
        backupExplorerApiType: "etherscan",
        backupExplorerApiUrl: "https://backup.etherscan.io/v2/api",
        backupExplorerApiKeyNeeded: false,
        backupExplorerApiKey: null,
        backupExplorerUrl: null,
        backupExplorerTxPath: null,
        backupExplorerAddressPath: null,
        backupExplorerContractPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // round 1: both fail
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      });
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      });
      // round 2: primary recovers
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve(makeEtherscanTxResponse([{ hash: "0xrecovered" }])),
      });

      const resultPromise = queryTransactionsCore(BASE_INPUT);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions[0].hash).toBe("0xrecovered");
      }
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not attempt backup when primary succeeds", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
        backupExplorerApiType: "blockscout",
        backupExplorerApiUrl: "https://backup.blockscout.io/api",
        backupExplorerApiKeyNeeded: false,
        backupExplorerApiKey: null,
        backupExplorerUrl: "https://backup.blockscout.io",
        backupExplorerTxPath: "/tx/{hash}",
        backupExplorerAddressPath: "/address/{address}",
        backupExplorerContractPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve(makeEtherscanTxResponse([{ hash: "0xprimary" }])),
      });

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions[0].hash).toBe("0xprimary");
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries primary alone when no backup is configured", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
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
      });

      const failResponse = {
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      };
      // round 1 and round 2 both fail
      mockFetch.mockResolvedValueOnce(failResponse);
      mockFetch.mockResolvedValueOnce(failResponse);

      const resultPromise = queryTransactionsCore(BASE_INPUT);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          "Rate limit exceeded. Please try again later."
        );
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns error immediately when backup requires an API key but none is set", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
        backupExplorerApiType: "etherscan",
        backupExplorerApiUrl: "https://backup.etherscan.io/v2/api",
        backupExplorerApiKeyNeeded: true,
        backupExplorerApiKey: null,
        backupExplorerUrl: null,
        backupExplorerTxPath: null,
        backupExplorerAddressPath: null,
        backupExplorerContractPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Primary fails — backup should not be attempted due to missing key
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            status: "0",
            message: "NOTOK",
            result: "Rate limit exceeded",
          }),
      });

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("All explorer providers failed");
        expect(result.error).toContain(
          "Backup explorer requires an API key but none is configured"
        );
      }
      // Primary called once (break on missing key exits after round 1), backup never called
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("falls back when primary throws a network error", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
        backupExplorerApiType: "etherscan",
        backupExplorerApiUrl: "https://backup.etherscan.io/v2/api",
        backupExplorerApiKeyNeeded: false,
        backupExplorerApiKey: null,
        backupExplorerUrl: null,
        backupExplorerTxPath: null,
        backupExplorerAddressPath: null,
        backupExplorerContractPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve(makeEtherscanTxResponse([{ hash: "0xrecovered" }])),
      });

      const result = await queryTransactionsCore(BASE_INPUT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions[0].hash).toBe("0xrecovered");
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("block range", () => {
    it("returns empty results when fromBlock > toBlock", async () => {
      mockFindFirst.mockResolvedValue({
        chainId: 1,
        chainType: "evm",
        explorerUrl: "https://etherscan.io",
        explorerApiType: "etherscan",
        explorerApiUrl: "https://api.etherscan.io/v2/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: null,
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
      });

      const result = await queryTransactionsCore({
        ...BASE_INPUT,
        fromBlock: "500",
        toBlock: "100",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactions).toEqual([]);
        expect(result.matchCount).toBe(0);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
