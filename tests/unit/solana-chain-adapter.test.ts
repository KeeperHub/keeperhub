import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// Mock the shared explorer module instead of the raw DB/schema/explorer internals
vi.mock("@/lib/web3/chain-adapter/explorer", () => ({
  buildChainTransactionUrl: vi.fn(),
  buildChainAddressUrl: vi.fn(),
  clearExplorerConfigCache: vi.fn(),
}));

vi.mock("@solana/web3.js", () => {
  class MockConnection {
    getBalance = vi.fn();
  }
  class MockPublicKey {
    readonly address: string;
    constructor(address: string) {
      if (address === "not-base58!!!") {
        throw new TypeError(`Invalid public key input: ${address}`);
      }
      this.address = address;
    }
  }
  return { Connection: MockConnection, PublicKey: MockPublicKey };
});

import {
  buildChainAddressUrl,
  buildChainTransactionUrl,
  clearExplorerConfigCache,
} from "@/lib/web3/chain-adapter/explorer";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";

const DEVNET_CHAIN_ID = 103;
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
const TEST_TX_HASH = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const INVALID_ADDRESS = "not-base58!!!";

function createMockFactory(getBalanceResult: number | Error = 5_000_000) {
  const mockGetBalance =
    getBalanceResult instanceof Error
      ? vi.fn().mockRejectedValue(getBalanceResult)
      : vi.fn().mockResolvedValue(getBalanceResult);

  const mockManager = {
    executeWithFailover: vi
      .fn()
      .mockImplementation(async (operation: (c: unknown) => Promise<unknown>) =>
        operation({ getBalance: mockGetBalance })
      ),
  };

  const factory = vi.fn().mockResolvedValue(mockManager);
  return { factory, mockManager, mockGetBalance };
}

describe("SolanaChainAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clearExplorerConfigCache)();
  });

  describe("chainFamily", () => {
    it("is 'solana'", () => {
      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      expect(adapter.chainFamily).toBe("solana");
    });
  });

  describe("getBalance", () => {
    it("returns lamports as bigint", async () => {
      const { factory, mockGetBalance } = createMockFactory(5_000_000);
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      const balance = await adapter.getBalance(
        null as never,
        SYSTEM_PROGRAM_ADDRESS
      );

      expect(balance).toBe(BigInt(5_000_000));
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });

    it("returns 0n when account has no lamports", async () => {
      const { factory } = createMockFactory(0);
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      const balance = await adapter.getBalance(
        null as never,
        SYSTEM_PROGRAM_ADDRESS
      );
      expect(balance).toBe(BigInt(0));
    });

    it("propagates RPC errors", async () => {
      const { factory } = createMockFactory(new Error("RPC error"));
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      await expect(
        adapter.getBalance(null as never, SYSTEM_PROGRAM_ADDRESS)
      ).rejects.toThrow("RPC error");
    });

    it("throws before any RPC call when address is not valid base58", async () => {
      const { factory, mockManager } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      await expect(
        adapter.getBalance(null as never, INVALID_ADDRESS)
      ).rejects.toThrow(`Invalid public key input: ${INVALID_ADDRESS}`);

      // The failover loop must never have been entered
      expect(mockManager.executeWithFailover).not.toHaveBeenCalled();
    });
  });

  describe("getTransactionUrl", () => {
    it("delegates to buildChainTransactionUrl with chainId and hash", async () => {
      vi.mocked(buildChainTransactionUrl).mockResolvedValue(
        "https://solscan.io/tx/abc123"
      );

      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      const url = await adapter.getTransactionUrl("abc123");
      expect(url).toBe("https://solscan.io/tx/abc123");
      expect(buildChainTransactionUrl).toHaveBeenCalledWith(
        DEVNET_CHAIN_ID,
        "abc123"
      );
    });

    it("returns empty string when no explorer config", async () => {
      vi.mocked(buildChainTransactionUrl).mockResolvedValue("");

      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      const url = await adapter.getTransactionUrl(TEST_TX_HASH);
      expect(url).toBe("");
    });

    it("degrades to empty string instead of throwing when the lookup fails", async () => {
      // A transfer step calls this after the transaction is already on-chain, so
      // a throw here would flip a completed transfer's result to failed.
      vi.mocked(buildChainTransactionUrl).mockRejectedValue(
        new Error("explorer config lookup failed")
      );

      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      await expect(adapter.getTransactionUrl(TEST_TX_HASH)).resolves.toBe("");
    });
  });

  describe("getAddressUrl", () => {
    it("delegates to buildChainAddressUrl with chainId and address", async () => {
      vi.mocked(buildChainAddressUrl).mockResolvedValue(
        "https://solscan.io/account/So111..."
      );

      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      const url = await adapter.getAddressUrl(SYSTEM_PROGRAM_ADDRESS);
      expect(url).toBe("https://solscan.io/account/So111...");
      expect(buildChainAddressUrl).toHaveBeenCalledWith(
        DEVNET_CHAIN_ID,
        SYSTEM_PROGRAM_ADDRESS
      );
    });

    it("returns empty string when no explorer config", async () => {
      vi.mocked(buildChainAddressUrl).mockResolvedValue("");

      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      const url = await adapter.getAddressUrl(SYSTEM_PROGRAM_ADDRESS);
      expect(url).toBe("");
    });

    it("degrades to empty string instead of throwing when the lookup fails", async () => {
      vi.mocked(buildChainAddressUrl).mockRejectedValue(
        new Error("explorer config lookup failed")
      );

      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      await expect(adapter.getAddressUrl(SYSTEM_PROGRAM_ADDRESS)).resolves.toBe(
        ""
      );
    });
  });

  describe("unsupported EVM operations", () => {
    it("readContract throws standard Error", async () => {
      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      await expect(
        adapter.readContract(null as never, null as never)
      ).rejects.toThrow("[SolanaChainAdapter] readContract is not supported");
    });

    it("sendTransaction throws if solanaSigner is missing from options", async () => {
      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      await expect(
        adapter.sendTransaction(
          null as never,
          { to: "11111111111111111111111111111111" },
          null as never,
          { gasOverrides: {} } // solanaSigner intentionally absent
        )
      ).rejects.toThrow("[SolanaChainAdapter] Missing options.solanaSigner");
    });

    it("executeContractCall throws standard Error", async () => {
      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      await expect(
        adapter.executeContractCall(
          null as never,
          null as never,
          null as never,
          null as never
        )
      ).rejects.toThrow(
        "[SolanaChainAdapter] executeContractCall is not supported"
      );
    });

    it("executeWithFailover throws standard Error", async () => {
      const { factory } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);
      await expect(
        adapter.executeWithFailover(null as never, null as never, "read")
      ).rejects.toThrow(
        "[SolanaChainAdapter] executeWithFailover via RpcProviderManager is not supported"
      );
    });
  });

  describe("executeWithSolanaFailover", () => {
    it("delegates to manager.executeWithFailover with the operation", async () => {
      const { factory, mockManager } = createMockFactory();
      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factory);

      const mockOp = vi.fn().mockResolvedValue(42);
      mockManager.executeWithFailover.mockResolvedValue(42);

      const result = await adapter.executeWithSolanaFailover(mockOp);

      expect(result).toBe(42);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(mockManager.executeWithFailover).toHaveBeenCalledWith(
        mockOp,
        undefined
      );
    });
  });

  describe("provider factory caching", () => {
    it("calls the factory only once across multiple operations", async () => {
      const factoryFn = vi.fn().mockResolvedValue({
        executeWithFailover: vi.fn().mockResolvedValue(BigInt(0)),
      });

      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factoryFn);
      await adapter.getBalance(null as never, SYSTEM_PROGRAM_ADDRESS);
      await adapter.getBalance(null as never, SYSTEM_PROGRAM_ADDRESS);

      expect(factoryFn).toHaveBeenCalledTimes(1);
    });

    it("calls the factory once for concurrent operations that start before it resolves", async () => {
      let resolveManager: (manager: unknown) => void = () => undefined;
      const managerReady = new Promise((resolve) => {
        resolveManager = resolve;
      });
      const factoryFn = vi.fn().mockReturnValue(managerReady);

      const adapter = new SolanaChainAdapter(DEVNET_CHAIN_ID, factoryFn);

      // Start both operations while the factory promise is still pending, so a
      // resolved-value cache (rather than a promise cache) would invoke the
      // factory twice.
      const first = adapter.getBalance(null as never, SYSTEM_PROGRAM_ADDRESS);
      const second = adapter.getBalance(null as never, SYSTEM_PROGRAM_ADDRESS);
      resolveManager({
        executeWithFailover: vi.fn().mockResolvedValue(BigInt(0)),
      });
      await Promise.all([first, second]);

      expect(factoryFn).toHaveBeenCalledTimes(1);
    });
  });
});
