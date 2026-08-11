import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers/solana` now imports `lib/safe-fetch`, which declares
// `import "server-only"` and would otherwise throw under vitest.
vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

import {
  clearSolanaProviderManagerCache,
  consoleSolanaMetricsCollector,
  createSolanaProviderManager,
  getAllSolanaFailoverStates,
  noopSolanaMetricsCollector,
  SolanaProviderManager,
  type SolanaRpcMetricsCollector,
} from "@/lib/rpc/providers/solana";

// Mock @solana/web3.js
vi.mock("@solana/web3.js", () => {
  class MockConnection {
    getSlot = vi.fn();
    getBalance = vi.fn();
    getAccountInfo = vi.fn();
    getVersion = vi.fn();
  }

  return {
    Connection: MockConnection,
  };
});

describe("SolanaProviderManager", () => {
  let metricsCollector: SolanaRpcMetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSolanaProviderManagerCache();

    metricsCollector = {
      recordPrimaryAttempt: vi.fn(),
      recordPrimaryFailure: vi.fn(),
      recordFallbackAttempt: vi.fn(),
      recordFallbackFailure: vi.fn(),
      recordFailoverEvent: vi.fn(),
      recordRecoveryEvent: vi.fn(),
      recordBothFailed: vi.fn(),
      recordSuccess: vi.fn(),
      recordLatency: vi.fn(),
      recordErrorType: vi.fn(),
    };
  });

  afterEach(() => {
    clearSolanaProviderManagerCache();
  });

  describe("constructor", () => {
    it("should create manager with default config values", () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
        },
      });

      expect(manager.getChainName()).toBe("solana");
      expect(manager.isCurrentlyUsingFallback()).toBe(false);
      expect(manager.getCurrentConnectionType()).toBe("primary");
    });

    it("should create manager with custom config values", () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 5,
          timeoutMs: 60_000,
          chainName: "Solana Mainnet",
          commitment: "finalized",
        },
        metricsCollector,
      });

      expect(manager.getChainName()).toBe("Solana Mainnet");
    });
  });

  describe("getMetrics", () => {
    it("should return initial metrics with zero values", () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
        },
      });

      const metrics = manager.getMetrics();

      expect(metrics).toEqual({
        primaryAttempts: 0,
        primaryFailures: 0,
        fallbackAttempts: 0,
        fallbackFailures: 0,
        totalRequests: 0,
        lastFailoverTime: null,
      });
    });
  });

  describe("executeWithFailover", () => {
    it("should execute operation successfully on primary", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          chainName: "Solana",
        },
        metricsCollector,
      });

      const mockOperation = vi.fn().mockResolvedValue(12_345);

      const result = await manager.executeWithFailover(mockOperation);

      expect(result).toBe(12_345);
      expect(mockOperation).toHaveBeenCalledTimes(1);
      expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledWith(
        "Solana",
        "read"
      );
      expect(manager.getMetrics().totalRequests).toBe(1);
      expect(manager.getMetrics().primaryAttempts).toBe(1);
    });

    it("should retry on primary failure before failing over", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 2,
          timeoutMs: 100,
          chainName: "Solana",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue(67_890);

      const result = await manager.executeWithFailover(mockOperation);

      expect(result).toBe(67_890);
      expect(mockOperation).toHaveBeenCalledTimes(2);
      expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(2);
      expect(metricsCollector.recordPrimaryFailure).toHaveBeenCalledTimes(1);
    });

    it("should failover to fallback when primary exhausts retries", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 2,
          timeoutMs: 100,
          chainName: "Solana",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed 1"))
        .mockRejectedValueOnce(new Error("Primary failed 2"))
        .mockResolvedValue(99_999);

      const result = await manager.executeWithFailover(mockOperation);

      expect(result).toBe(99_999);
      expect(manager.isCurrentlyUsingFallback()).toBe(true);
      expect(metricsCollector.recordFailoverEvent).toHaveBeenCalledWith(
        "Solana"
      );
    });

    it("should throw error when both primary and fallback fail", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Solana",
        },
        metricsCollector,
      });

      const mockOperation = vi.fn().mockRejectedValue(new Error("All failed"));

      await expect(manager.executeWithFailover(mockOperation)).rejects.toThrow(
        "Solana RPC failed on both endpoints"
      );
    });

    it("masks keyed RPC URLs that provider errors inline into the thrown message", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Solana",
        },
        metricsCollector,
      });

      const fakeAlchemyKey = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAA";
      const mockOperation = vi
        .fn()
        .mockRejectedValue(
          new Error(
            `failed to get balance: fetch https://solana-mainnet.g.alchemy.com/v2/${fakeAlchemyKey} returned 401`
          )
        );

      await expect(
        manager.executeWithFailover(mockOperation)
      ).rejects.toSatisfy((error: unknown) => {
        const message = (error as Error).message;
        expect(message).toContain("Solana RPC failed on both endpoints");
        expect(message).not.toContain(fakeAlchemyKey);
        // Provider identity must not reach users: the whole URL goes,
        // host included.
        expect(message).not.toContain("solana-mainnet.g.alchemy.com");
        expect(message).toContain("[REDACTED-URL]");
        return true;
      });
    });

    it("should throw error when primary fails and no fallback configured", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Solana",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValue(new Error("Primary failed"));

      await expect(manager.executeWithFailover(mockOperation)).rejects.toThrow(
        "Solana RPC failed on primary endpoint"
      );
    });

    it("should call failover state change callback on failover", async () => {
      const onFailoverStateChange = vi.fn();

      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Solana",
        },
        onFailoverStateChange,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue(12_345);

      await manager.executeWithFailover(mockOperation);

      expect(onFailoverStateChange).toHaveBeenCalledWith(
        "Solana",
        true,
        "failover"
      );
    });

    it("should recover to primary when fallback fails and primary comes back online", async () => {
      const onFailoverStateChange = vi.fn();

      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Solana",
        },
        onFailoverStateChange,
      });

      // First call - primary fails, fallback succeeds -> enters failover state
      const failOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue(11_111);

      await manager.executeWithFailover(failOperation);
      expect(manager.isCurrentlyUsingFallback()).toBe(true);

      // Second call - fallback fails, primary recovers -> exits failover state
      const recoverOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fallback failed"))
        .mockResolvedValue(22_222);

      await manager.executeWithFailover(recoverOperation);
      expect(manager.isCurrentlyUsingFallback()).toBe(false);
      expect(onFailoverStateChange).toHaveBeenCalledWith(
        "Solana",
        false,
        "recovery"
      );
    });
  });

  describe("setFailoverStateChangeCallback", () => {
    it("should update the callback", async () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Solana",
        },
      });

      const newCallback = vi.fn();
      manager.setFailoverStateChangeCallback(newCallback);

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue(12_345);

      await manager.executeWithFailover(mockOperation);

      expect(newCallback).toHaveBeenCalledWith("Solana", true, "failover");
    });
  });

  describe("getConnection", () => {
    it("should return primary connection when not in fallback state", () => {
      const manager = new SolanaProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
        },
      });

      const connection = manager.getConnection();
      expect(connection).toBeDefined();
      expect(manager.isCurrentlyUsingFallback()).toBe(false);
    });
  });
});

describe("createSolanaProviderManager", () => {
  beforeEach(() => {
    clearSolanaProviderManagerCache();
  });

  afterEach(() => {
    clearSolanaProviderManagerCache();
  });

  it("should create a new manager", () => {
    const manager = createSolanaProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Solana",
    });

    expect(manager).toBeInstanceOf(SolanaProviderManager);
    expect(manager.getChainName()).toBe("Solana");
  });

  it("should cache managers by URL combination", () => {
    const manager1 = createSolanaProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Solana",
    });

    const manager2 = createSolanaProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Solana",
    });

    expect(manager1).toBe(manager2);
  });

  it("should create different managers for different URLs", () => {
    const manager1 = createSolanaProviderManager({
      primaryRpcUrl: "https://primary1.example.com",
      chainName: "Solana Mainnet",
    });

    const manager2 = createSolanaProviderManager({
      primaryRpcUrl: "https://primary2.example.com",
      chainName: "Solana Devnet",
    });

    expect(manager1).not.toBe(manager2);
  });

  it("should update callback on cached manager", () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    createSolanaProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Solana",
      onFailoverStateChange: callback1,
    });

    const manager = createSolanaProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Solana",
      onFailoverStateChange: callback2,
    });

    expect(manager).toBeDefined();
  });
});

describe("getAllSolanaFailoverStates", () => {
  beforeEach(() => {
    clearSolanaProviderManagerCache();
  });

  afterEach(() => {
    clearSolanaProviderManagerCache();
  });

  it("should return empty map when no managers exist", () => {
    const states = getAllSolanaFailoverStates();
    expect(states.size).toBe(0);
  });

  it("should return states for all cached managers", () => {
    createSolanaProviderManager({
      primaryRpcUrl: "https://solana-mainnet.example.com",
      chainName: "Solana Mainnet",
    });

    createSolanaProviderManager({
      primaryRpcUrl: "https://solana-devnet.example.com",
      chainName: "Solana Devnet",
    });

    const states = getAllSolanaFailoverStates();

    expect(states.size).toBe(2);

    const values = Array.from(states.values());
    expect(values).toContainEqual({
      chainName: "Solana Mainnet",
      isUsingFallback: false,
    });
    expect(values).toContainEqual({
      chainName: "Solana Devnet",
      isUsingFallback: false,
    });
  });
});

describe("noopSolanaMetricsCollector", () => {
  it("should not throw when called", () => {
    expect(() =>
      noopSolanaMetricsCollector.recordPrimaryAttempt("test")
    ).not.toThrow();
    expect(() =>
      noopSolanaMetricsCollector.recordPrimaryFailure("test")
    ).not.toThrow();
    expect(() =>
      noopSolanaMetricsCollector.recordFallbackAttempt("test")
    ).not.toThrow();
    expect(() =>
      noopSolanaMetricsCollector.recordFallbackFailure("test")
    ).not.toThrow();
    expect(() =>
      noopSolanaMetricsCollector.recordFailoverEvent("test")
    ).not.toThrow();
  });
});

describe("consoleSolanaMetricsCollector", () => {
  it("should log to console.debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {
      // Intentionally empty - suppress console output during tests
    });

    consoleSolanaMetricsCollector.recordPrimaryAttempt("Solana");
    expect(debugSpy).toHaveBeenCalledWith(
      "[Solana RPC Metrics] Primary attempt: Solana [read]"
    );

    consoleSolanaMetricsCollector.recordPrimaryFailure("Solana");
    expect(debugSpy).toHaveBeenCalledWith(
      "[Solana RPC Metrics] Primary failure: Solana [read]"
    );

    debugSpy.mockRestore();
  });
});
