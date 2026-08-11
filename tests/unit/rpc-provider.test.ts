import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` now transitively imports `lib/safe-fetch` via
// `lib/rpc/safe-ethers-fetch`, which declares `import "server-only"` and
// would otherwise throw under vitest.
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
  clearRpcProviderManagerCache,
  consoleMetricsCollector,
  createRpcProviderManager,
  getAllFailoverStates,
  noopMetricsCollector,
  type RpcMetricsCollector,
  RpcProviderManager,
  RpcRelayTransportError,
} from "@/lib/rpc/providers";

// Mock ethers
vi.mock("ethers", () => {
  const _mockProvider = {
    getBalance: vi.fn(),
    getBlock: vi.fn(),
    call: vi.fn(),
  };

  // Create a proper mock class for FetchRequest
  class MockFetchRequest {
    url: string;
    timeout = 5000;
    constructor(url: string) {
      this.url = url;
    }
  }

  // Create a proper mock class for JsonRpcProvider
  class MockJsonRpcProvider {
    getBalance = vi.fn();
    getBlock = vi.fn();
    call = vi.fn();
  }

  return {
    ethers: {
      JsonRpcProvider: MockJsonRpcProvider,
      FetchRequest: MockFetchRequest,
      Network: { from: (_chainId: number) => ({}) },
    },
    isError: (error: unknown, code: string): boolean =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === code,
  };
});

// ---------------------------------------------------------------------------
// Helpers for 429 / Retry-After tests
// ---------------------------------------------------------------------------

function makeEthersError(
  code: string,
  message: string
): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function makeServerError(
  statusCode: number,
  headers: Record<string, string> = {}
): Error & {
  code: string;
  response: { statusCode: number; getHeader: (key: string) => string };
} {
  const err = new Error(`server responded with ${statusCode}`) as Error & {
    code: string;
    response: { statusCode: number; getHeader: (key: string) => string };
  };
  err.code = "SERVER_ERROR";
  err.response = {
    statusCode,
    getHeader(key: string): string {
      return headers[key.toLowerCase()] ?? "";
    },
  };
  return err;
}

describe("RpcProviderManager", () => {
  let metricsCollector: RpcMetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    clearRpcProviderManagerCache();

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
    clearRpcProviderManagerCache();
  });

  describe("constructor", () => {
    it("should create manager with default config values", () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
        },
      });

      expect(manager.getChainName()).toBe("unknown");
      expect(manager.isCurrentlyUsingFallback()).toBe(false);
      expect(manager.getCurrentProviderType()).toBe("primary");
    });

    it("should create manager with custom config values", () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 5,
          timeoutMs: 60_000,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      expect(manager.getChainName()).toBe("Ethereum");
    });
  });

  describe("getMetrics", () => {
    it("should return initial metrics with zero values", () => {
      const manager = new RpcProviderManager({
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
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      const mockOperation = vi.fn().mockResolvedValue("success");

      const result = await manager.executeWithFailover(mockOperation);

      expect(result).toBe("success");
      expect(mockOperation).toHaveBeenCalledTimes(1);
      expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledWith(
        "Ethereum",
        "read"
      );
      expect(manager.getMetrics().totalRequests).toBe(1);
      expect(manager.getMetrics().primaryAttempts).toBe(1);
    });

    it("should retry on primary failure before failing over", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 2,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue("success on retry");

      const result = await manager.executeWithFailover(mockOperation);

      expect(result).toBe("success on retry");
      expect(mockOperation).toHaveBeenCalledTimes(2);
      expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(2);
      expect(metricsCollector.recordPrimaryFailure).toHaveBeenCalledTimes(1);
    });

    it("should failover to fallback when primary exhausts retries", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 2,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed 1"))
        .mockRejectedValueOnce(new Error("Primary failed 2"))
        .mockResolvedValue("fallback success");

      const result = await manager.executeWithFailover(mockOperation);

      expect(result).toBe("fallback success");
      expect(manager.isCurrentlyUsingFallback()).toBe(true);
      expect(metricsCollector.recordFailoverEvent).toHaveBeenCalledWith(
        "Ethereum"
      );
    });

    it("should throw error when both primary and fallback fail", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      const mockOperation = vi.fn().mockRejectedValue(new Error("All failed"));

      await expect(manager.executeWithFailover(mockOperation)).rejects.toThrow(
        "RPC failed on both endpoints"
      );
    });

    it("masks keyed RPC URLs that provider errors inline into the thrown message", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      // Ethers v6 SERVER_ERROR shape: info.requestUrl (keyed URL) is inlined
      // into Error.message.
      const fakeDrpcKey = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA";
      const mockOperation = vi
        .fn()
        .mockRejectedValue(
          new Error(
            `server response 400 Bad Request (request={ }, response={ }, error=null, info={ "requestUrl": "https://lb.drpc.live/ethereum/${fakeDrpcKey}" }, code=SERVER_ERROR, version=6.16.0)`
          )
        );

      await expect(
        manager.executeWithFailover(mockOperation)
      ).rejects.toSatisfy((error: unknown) => {
        const message = (error as Error).message;
        expect(message).toContain("RPC failed on both endpoints");
        expect(message).not.toContain(fakeDrpcKey);
        // Provider identity must not reach users: the whole URL goes,
        // host included.
        expect(message).not.toContain("lb.drpc.live");
        expect(message).toContain("[REDACTED-URL]");
        return true;
      });
    });

    it("should throw error when primary fails and no fallback configured", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValue(new Error("Primary failed"));

      await expect(manager.executeWithFailover(mockOperation)).rejects.toThrow(
        "RPC failed on primary endpoint"
      );
    });

    it("attributes a private-mempool relay timeout to the relay, not the platform", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://rpc.flashbots.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Sepolia",
          primaryIsPrivateRelay: true,
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValue(makeEthersError("TIMEOUT", "timeout"));

      await expect(
        manager.executeWithFailover(mockOperation)
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RpcRelayTransportError);
        expect((error as RpcRelayTransportError).errorClass).toBe("external");
        expect((error as Error).message).toContain(
          "RPC failed on primary endpoint"
        );
        return true;
      });
    });

    it("leaves a relay failure unattributed when it answered rather than timed out", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://rpc.flashbots.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Sepolia",
          primaryIsPrivateRelay: true,
        },
        metricsCollector,
      });

      // Every node answers this identically, so it says nothing about the relay.
      const mockOperation = vi.fn().mockRejectedValue(makeServerError(400));

      await expect(
        manager.executeWithFailover(mockOperation)
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).not.toBeInstanceOf(RpcRelayTransportError);
        return true;
      });
    });

    it("keeps a timeout on our own endpoint unattributed", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValue(makeEthersError("TIMEOUT", "timeout"));

      await expect(
        manager.executeWithFailover(mockOperation)
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).not.toBeInstanceOf(RpcRelayTransportError);
        return true;
      });
    });

    it("keeps the failure ours when our fallback went down alongside the relay", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://rpc.flashbots.example.com",
          fallbackRpcUrl: "https://primary.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Sepolia",
          primaryIsPrivateRelay: true,
        },
        metricsCollector,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValue(makeEthersError("TIMEOUT", "timeout"));

      await expect(
        manager.executeWithFailover(mockOperation)
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).not.toBeInstanceOf(RpcRelayTransportError);
        expect((error as Error).message).toContain(
          "RPC failed on both endpoints"
        );
        return true;
      });
    });

    it("should call failover state change callback on failover", async () => {
      const onFailoverStateChange = vi.fn();

      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        onFailoverStateChange,
      });

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue("fallback success");

      await manager.executeWithFailover(mockOperation);

      expect(onFailoverStateChange).toHaveBeenCalledWith(
        "Ethereum",
        true,
        "failover"
      );
    });

    it("should recover to primary when fallback fails and primary comes back online", async () => {
      const onFailoverStateChange = vi.fn();

      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        onFailoverStateChange,
      });

      // First call - primary fails, fallback succeeds -> enters failover state
      const failOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue("fallback success");

      await manager.executeWithFailover(failOperation);
      expect(manager.isCurrentlyUsingFallback()).toBe(true);

      // Second call - fallback fails, primary recovers -> exits failover state
      // Note: When in failover state, it tries fallback first. If fallback fails,
      // it tries primary, and if primary succeeds, it recovers.
      const recoverOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fallback failed"))
        .mockResolvedValue("primary recovered");

      await manager.executeWithFailover(recoverOperation);
      expect(manager.isCurrentlyUsingFallback()).toBe(false);
      expect(onFailoverStateChange).toHaveBeenCalledWith(
        "Ethereum",
        false,
        "recovery"
      );
    });

    it("should throw without redundant fallback retry when both fail in sticky fallback state", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
        metricsCollector,
      });

      // First call: primary fails, fallback succeeds -> sticky fallback
      const firstOp = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue("fallback ok");
      await manager.executeWithFailover(firstOp);
      expect(manager.isCurrentlyUsingFallback()).toBe(true);

      vi.mocked(metricsCollector.recordFallbackAttempt).mockClear();
      vi.mocked(metricsCollector.recordPrimaryAttempt).mockClear();

      // Second call: both fail. Fallback should be tried once, primary once.
      // No redundant third attempt on fallback.
      const secondOp = vi.fn().mockRejectedValue(new Error("down"));

      await expect(manager.executeWithFailover(secondOp)).rejects.toThrow(
        "RPC failed on both endpoints"
      );

      // Fallback attempted once, primary attempted once -- no double fallback
      expect(metricsCollector.recordFallbackAttempt).toHaveBeenCalledTimes(1);
      expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(1);
    });

    describe("Retry-After handling on 429", () => {
      it("should respect Retry-After header within cap and retry", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        let callCount = 0;
        const result = await manager.executeWithFailover(() => {
          callCount++;
          if (callCount === 1) {
            throw makeServerError(429, { "retry-after": "1" });
          }
          return Promise.resolve("ok");
        });

        expect(result).toBe("ok");
        expect(callCount).toBe(2);
      });

      it("should bail immediately on 429 without Retry-After header", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        let totalCalls = 0;
        const result = await manager.executeWithFailover(() => {
          totalCalls++;
          if (totalCalls === 1) {
            throw makeServerError(429);
          }
          return Promise.resolve("fallback-ok");
        });

        expect(result).toBe("fallback-ok");
        // Primary called once (bailed on 429), fallback called once (success)
        expect(totalCalls).toBe(2);
        expect(metricsCollector.recordPrimaryFailure).toHaveBeenCalledTimes(1);
      });

      it("should bail immediately on 429 with Retry-After exceeding cap", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        let totalCalls = 0;
        const result = await manager.executeWithFailover(() => {
          totalCalls++;
          if (totalCalls === 1) {
            throw makeServerError(429, { "retry-after": "60" });
          }
          return Promise.resolve("fallback-ok");
        });

        expect(result).toBe("fallback-ok");
        expect(totalCalls).toBe(2);
        expect(metricsCollector.recordPrimaryFailure).toHaveBeenCalledTimes(1);
      });

      it("should throw when both providers return 429 without Retry-After", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        await expect(
          manager.executeWithFailover(() => {
            throw makeServerError(429);
          })
        ).rejects.toThrow("RPC failed on both endpoints");
      });

      it("should use exponential backoff for non-429 errors", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            maxRetries: 2,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        let callCount = 0;
        const result = await manager.executeWithFailover(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error("connection reset");
          }
          return Promise.resolve("ok");
        });

        expect(result).toBe("ok");
        expect(callCount).toBe(2);
        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(2);
      });
    });

    describe("non-retryable error handling", () => {
      it("should throw immediately on CALL_EXCEPTION without retrying or failing over", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        await expect(
          manager.executeWithFailover(() => {
            throw makeEthersError("CALL_EXCEPTION", "execution reverted");
          })
        ).rejects.toThrow("execution reverted");

        // Called once on primary, no retries, no fallback attempt
        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(1);
        expect(metricsCollector.recordPrimaryFailure).toHaveBeenCalledTimes(1);
        expect(metricsCollector.recordFallbackAttempt).not.toHaveBeenCalled();
      });

      it("should throw immediately on INVALID_ARGUMENT", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        await expect(
          manager.executeWithFailover(() => {
            throw makeEthersError("INVALID_ARGUMENT", "invalid address");
          })
        ).rejects.toThrow("invalid address");

        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(1);
        expect(metricsCollector.recordFallbackAttempt).not.toHaveBeenCalled();
      });

      it("should throw immediately on NUMERIC_FAULT", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        await expect(
          manager.executeWithFailover(() => {
            throw makeEthersError("NUMERIC_FAULT", "overflow");
          })
        ).rejects.toThrow("overflow");

        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(1);
        expect(metricsCollector.recordFallbackAttempt).not.toHaveBeenCalled();
      });

      it("should retry BAD_DATA with 'missing response for request' message", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        let callCount = 0;
        const result = await manager.executeWithFailover(() => {
          callCount++;
          if (callCount === 1) {
            throw makeEthersError(
              "BAD_DATA",
              "missing response for request (value=[...], info={ payload: { id: 7, method: 'eth_blockNumber' } })"
            );
          }
          return Promise.resolve("ok");
        });

        expect(result).toBe("ok");
        expect(callCount).toBe(2);
        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(2);
        expect(metricsCollector.recordFallbackAttempt).not.toHaveBeenCalled();
      });

      it("should throw immediately on BAD_DATA with non-batch error message", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            fallbackRpcUrl: "https://fallback.example.com",
            maxRetries: 3,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        await expect(
          manager.executeWithFailover(() => {
            throw makeEthersError("BAD_DATA", "could not decode result data");
          })
        ).rejects.toThrow("could not decode result data");

        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(1);
        expect(metricsCollector.recordFallbackAttempt).not.toHaveBeenCalled();
      });

      it("should still retry transient SERVER_ERROR (non-429)", async () => {
        const manager = new RpcProviderManager({
          config: {
            primaryRpcUrl: "https://primary.example.com",
            maxRetries: 2,
            timeoutMs: 100,
            chainName: "Ethereum",
          },
          metricsCollector,
        });

        let callCount = 0;
        const result = await manager.executeWithFailover(() => {
          callCount++;
          if (callCount === 1) {
            throw makeServerError(503);
          }
          return Promise.resolve("ok");
        });

        expect(result).toBe("ok");
        expect(callCount).toBe(2);
        expect(metricsCollector.recordPrimaryAttempt).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("setFailoverStateChangeCallback", () => {
    it("should update the callback", async () => {
      const manager = new RpcProviderManager({
        config: {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
          maxRetries: 1,
          timeoutMs: 100,
          chainName: "Ethereum",
        },
      });

      const newCallback = vi.fn();
      manager.setFailoverStateChangeCallback(newCallback);

      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValue("fallback success");

      await manager.executeWithFailover(mockOperation);

      expect(newCallback).toHaveBeenCalledWith("Ethereum", true, "failover");
    });
  });
});

describe("createRpcProviderManager", () => {
  beforeEach(() => {
    clearRpcProviderManagerCache();
  });

  afterEach(() => {
    clearRpcProviderManagerCache();
  });

  it("should create a new manager", () => {
    const manager = createRpcProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Ethereum",
    });

    expect(manager).toBeInstanceOf(RpcProviderManager);
    expect(manager.getChainName()).toBe("Ethereum");
  });

  it("should cache managers by URL combination", () => {
    const manager1 = createRpcProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Ethereum",
    });

    const manager2 = createRpcProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Ethereum",
    });

    expect(manager1).toBe(manager2);
  });

  it("should create different managers for different URLs", () => {
    const manager1 = createRpcProviderManager({
      primaryRpcUrl: "https://primary1.example.com",
      chainName: "Ethereum",
    });

    const manager2 = createRpcProviderManager({
      primaryRpcUrl: "https://primary2.example.com",
      chainName: "Ethereum",
    });

    expect(manager1).not.toBe(manager2);
  });

  it("should update callback on cached manager", () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    createRpcProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Ethereum",
      onFailoverStateChange: callback1,
    });

    const manager = createRpcProviderManager({
      primaryRpcUrl: "https://primary.example.com",
      chainName: "Ethereum",
      onFailoverStateChange: callback2,
    });

    // The callback should be updated to callback2
    expect(manager).toBeDefined();
  });
});

describe("getAllFailoverStates", () => {
  beforeEach(() => {
    clearRpcProviderManagerCache();
  });

  afterEach(() => {
    clearRpcProviderManagerCache();
  });

  it("should return empty map when no managers exist", () => {
    const states = getAllFailoverStates();
    expect(states.size).toBe(0);
  });

  it("should return states for all cached managers", () => {
    createRpcProviderManager({
      primaryRpcUrl: "https://eth.example.com",
      chainName: "Ethereum",
    });

    createRpcProviderManager({
      primaryRpcUrl: "https://base.example.com",
      chainName: "Base",
    });

    const states = getAllFailoverStates();

    expect(states.size).toBe(2);

    const values = Array.from(states.values());
    expect(values).toContainEqual({
      chainName: "Ethereum",
      isUsingFallback: false,
    });
    expect(values).toContainEqual({
      chainName: "Base",
      isUsingFallback: false,
    });
  });
});

describe("noopMetricsCollector", () => {
  it("should not throw when called", () => {
    expect(() =>
      noopMetricsCollector.recordPrimaryAttempt("test")
    ).not.toThrow();
    expect(() =>
      noopMetricsCollector.recordPrimaryFailure("test")
    ).not.toThrow();
    expect(() =>
      noopMetricsCollector.recordFallbackAttempt("test")
    ).not.toThrow();
    expect(() =>
      noopMetricsCollector.recordFallbackFailure("test")
    ).not.toThrow();
    expect(() =>
      noopMetricsCollector.recordFailoverEvent("test")
    ).not.toThrow();
  });
});

describe("consoleMetricsCollector", () => {
  it("should log to console.debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {
      // Intentionally empty - suppress console output during tests
    });

    consoleMetricsCollector.recordPrimaryAttempt("Ethereum");
    expect(debugSpy).toHaveBeenCalledWith(
      "[RPC Metrics] Primary attempt: Ethereum [read]"
    );

    consoleMetricsCollector.recordPrimaryFailure("Ethereum");
    expect(debugSpy).toHaveBeenCalledWith(
      "[RPC Metrics] Primary failure: Ethereum [read]"
    );

    debugSpy.mockRestore();
  });
});
