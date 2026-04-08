import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock database - returns empty array (no config in DB, use hardcoded fallback)
vi.mock("@/lib/db", () => {
  const mockQueryChain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return {
    db: mockQueryChain,
  };
});

vi.mock("@/lib/db/schema", () => ({
  chains: {
    gasConfig: "gas_config",
    chainId: "chain_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ column: a, value: b })),
}));

// Mock ethers
vi.mock("ethers", () => ({
  ethers: {
    parseUnits: vi.fn((value: string, unit: string) => {
      const num = Number.parseFloat(value);
      if (unit === "gwei") {
        return BigInt(Math.floor(num * 1e9));
      }
      return BigInt(Math.floor(num * 1e18));
    }),
    formatUnits: vi.fn((value: bigint, unit: string) => {
      if (unit === "gwei") {
        return (Number(value) / 1e9).toString();
      }
      return (Number(value) / 1e18).toString();
    }),
  },
}));

// Import after mocks
import {
  AdaptiveGasStrategy,
  DEFAULT_RETRY_CONFIG,
  executeWithRetry,
  getGasStrategy,
  resetGasStrategy,
  TransactionStuckError,
  type TriggerType,
} from "@/lib/web3/gas-strategy";

// Helper to create mock provider
function createMockProvider(
  options: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
    feeHistory?: {
      baseFeePerGas: string[];
      reward: string[][];
    };
  } = {}
) {
  const defaultFeeHistory = {
    baseFeePerGas: [
      "0x2540be400", // 10 gwei
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400",
      "0x2540be400", // Next block prediction
    ],
    reward: [
      ["0x3b9aca00"], // 1 gwei
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
      ["0x3b9aca00"],
    ],
  };

  return {
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: options.maxFeePerGas ?? BigInt(20e9), // 20 gwei
      maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? BigInt(2e9), // 2 gwei
      gasPrice: options.gasPrice ?? BigInt(20e9),
    }),
    send: vi.fn().mockResolvedValue(options.feeHistory ?? defaultFeeHistory),
  };
}

describe("AdaptiveGasStrategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGasStrategy();
  });

  describe("constructor", () => {
    it("should create instance with default config", () => {
      const strategy = new AdaptiveGasStrategy();
      expect(strategy).toBeInstanceOf(AdaptiveGasStrategy);
    });

    it("should create instance with custom config", () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 3.0,
        volatilityThreshold: 0.5,
      });
      expect(strategy).toBeInstanceOf(AdaptiveGasStrategy);
    });
  });

  describe("getGasConfig", () => {
    it("should return gas config with limit, maxFee, and maxPriorityFee", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(21_000),
        1
      );

      expect(config.gasLimit).toBeDefined();
      expect(config.maxFeePerGas).toBeDefined();
      expect(config.maxPriorityFeePerGas).toBeDefined();
      expect(typeof config.gasLimit).toBe("bigint");
      expect(typeof config.maxFeePerGas).toBe("bigint");
      expect(typeof config.maxPriorityFeePerGas).toBe("bigint");
    });

    it("should apply gas limit multiplier to estimated gas", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled", // Non time-sensitive
        BigInt(100_000),
        1
      );

      // With 2.0 multiplier, 100000 becomes 200000
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should use conservative multiplier for time-sensitive triggers", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
        gasLimitMultiplierConservative: 2.5,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event", // Time-sensitive
        BigInt(100_000),
        1
      );

      // With 2.5 conservative multiplier, 100000 becomes 250000
      expect(config.gasLimit).toBe(BigInt(250_000));
    });
  });

  describe("trigger type handling", () => {
    const triggerTypes: TriggerType[] = [
      "event",
      "webhook",
      "scheduled",
      "manual",
    ];

    it.each(
      triggerTypes
    )("should handle %s trigger type", async (triggerType) => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        triggerType,
        BigInt(21_000),
        1
      );

      expect(config.gasLimit).toBeGreaterThan(BigInt(0));
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
    });

    it("should use conservative fees for event triggers", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      // Event trigger should NOT call fee history (goes straight to conservative)
      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(21_000),
        1
      );

      // Should call getFeeData for conservative estimate
      expect(provider.getFeeData).toHaveBeenCalled();
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
    });

    it("should use conservative fees for webhook triggers", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "webhook",
        BigInt(21_000),
        1
      );

      expect(provider.getFeeData).toHaveBeenCalled();
    });
  });

  describe("volatility detection", () => {
    it("should detect high volatility and use conservative fees", async () => {
      const strategy = new AdaptiveGasStrategy({
        volatilityThreshold: 0.3,
      });

      // High volatility: widely varying base fees
      const provider = createMockProvider({
        feeHistory: {
          baseFeePerGas: [
            "0x174876e800", // 100 gwei
            "0x2e90edd000", // 200 gwei
            "0x4a817c8000", // 320 gwei
            "0x174876e800", // 100 gwei
            "0x5d21dba000", // 400 gwei
            "0x174876e800", // 100 gwei
            "0x2e90edd000", // 200 gwei
            "0x4a817c8000", // 320 gwei
            "0x174876e800", // 100 gwei
            "0x5d21dba000", // 400 gwei
            "0x2e90edd000", // Next block
          ],
          reward: [
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
          ],
        },
      });

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled", // Would normally use optimized
        BigInt(21_000),
        1
      );

      // Should fall back to conservative due to high volatility
      expect(provider.getFeeData).toHaveBeenCalled();
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
    });

    it("should use optimized fees for low volatility scheduled triggers", async () => {
      const strategy = new AdaptiveGasStrategy();

      // Low volatility: stable base fees
      const provider = createMockProvider({
        feeHistory: {
          baseFeePerGas: [
            "0x2540be400", // 10 gwei
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
            "0x2540be400",
          ],
          reward: [
            ["0x3b9aca00"], // 1 gwei
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
            ["0x3b9aca00"],
          ],
        },
      });

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(21_000),
        1
      );

      // Should use optimized path
      expect(provider.send).toHaveBeenCalled();
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
    });
  });

  describe("chain-specific configurations", () => {
    it("should apply Ethereum mainnet config", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(21_000),
        1 // Ethereum mainnet
      );

      expect(config.gasLimit).toBeGreaterThan(BigInt(0));
    });

    it("should apply Arbitrum config with lower multiplier", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      // Arbitrum uses 1.5x multiplier (L2 estimates are more accurate)
      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        42_161 // Arbitrum One
      );

      // Arbitrum uses 1.5x for non-conservative
      expect(config.gasLimit).toBe(BigInt(150_000));
    });

    it("should apply Base config", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        8453 // Base
      );

      // Base uses 1.5x multiplier
      expect(config.gasLimit).toBe(BigInt(150_000));
    });

    it("should apply Polygon config with higher min priority fee", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider({
        maxPriorityFeePerGas: BigInt(1e9), // 1 gwei - below Polygon minimum
      });

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(21_000),
        137 // Polygon
      );

      // Polygon has 30 gwei minimum priority fee
      // Conservative path adds 20%, so should clamp to at least 30 gwei
      expect(config.maxPriorityFeePerGas).toBeGreaterThanOrEqual(BigInt(30e9));
    });

    it("should use default config for unknown chains", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        999_999 // Unknown chain
      );

      // Should use default 2.0x multiplier
      expect(config.gasLimit).toBe(BigInt(200_000));
    });
  });

  describe("priority fee clamping", () => {
    it("should clamp priority fee to minimum", async () => {
      const strategy = new AdaptiveGasStrategy({
        minPriorityFeeGwei: 1.0, // 1 gwei minimum
      });

      const provider = createMockProvider({
        maxPriorityFeePerGas: BigInt(0.01e9), // Very low priority fee
      });

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(21_000),
        1
      );

      // Should be clamped to at least minimum (accounting for chain config)
      expect(config.maxPriorityFeePerGas).toBeGreaterThanOrEqual(BigInt(0.5e9));
    });

    it("should clamp priority fee to maximum", async () => {
      const strategy = new AdaptiveGasStrategy({
        maxPriorityFeeGwei: 100, // 100 gwei maximum
      });

      const provider = createMockProvider({
        maxPriorityFeePerGas: BigInt(500e9), // 500 gwei - way too high
      });

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(21_000),
        1
      );

      // Should be clamped to maximum
      expect(config.maxPriorityFeePerGas).toBeLessThanOrEqual(BigInt(500e9));
    });
  });

  describe("legacy gas price fallback", () => {
    it("should handle non-EIP-1559 chains", async () => {
      const strategy = new AdaptiveGasStrategy();

      const provider = createMockProvider({
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
        gasPrice: BigInt(50e9), // 50 gwei legacy gas price
      });

      // Override getFeeData to return legacy format
      provider.getFeeData.mockResolvedValue({
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        gasPrice: BigInt(50e9),
      });

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(21_000),
        1
      );

      // Should derive EIP-1559 params from legacy gas price
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
      expect(config.maxPriorityFeePerGas).toBeGreaterThan(BigInt(0));
    });
  });

  describe("fee history fallback", () => {
    it("should fallback to conservative on fee history error", async () => {
      const strategy = new AdaptiveGasStrategy();

      const provider = createMockProvider();
      // Make fee history fail
      provider.send.mockRejectedValue(new Error("RPC method not supported"));

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled", // Would normally use optimized path
        BigInt(21_000),
        1
      );

      // Should still return valid config (fallback to conservative)
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
      expect(config.maxPriorityFeePerGas).toBeGreaterThan(BigInt(0));
    });
  });

  describe("singleton pattern", () => {
    it("should return same instance from getGasStrategy", () => {
      const strategy1 = getGasStrategy();
      const strategy2 = getGasStrategy();

      expect(strategy1).toBe(strategy2);
    });

    it("should return new instance after reset", () => {
      const strategy1 = getGasStrategy();
      resetGasStrategy();
      const strategy2 = getGasStrategy();

      expect(strategy1).not.toBe(strategy2);
    });

    it("should ignore config after first initialization", () => {
      const strategy1 = getGasStrategy({ gasLimitMultiplier: 1.5 });
      const strategy2 = getGasStrategy({ gasLimitMultiplier: 3.0 });

      // Second call ignores config - same instance
      expect(strategy1).toBe(strategy2);
    });
  });

  describe("percentile selection", () => {
    it("should select appropriate percentile based on volatility", async () => {
      // Test different volatility levels by examining the path taken
      const strategy = new AdaptiveGasStrategy();

      // Very stable network (CV < 0.15) - should use 50th percentile
      const stableProvider = createMockProvider({
        feeHistory: {
          baseFeePerGas: new Array(11).fill("0x2540be400"), // All same
          reward: new Array(10).fill(["0x3b9aca00"]),
        },
      });

      await strategy.getGasConfig(
        stableProvider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(21_000),
        1
      );

      // Verify it called eth_feeHistory for percentile estimation
      expect(stableProvider.send).toHaveBeenCalled();
    });
  });

  describe("gas limit multiplier override", () => {
    it("should use override multiplier when provided", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(100_000),
        1,
        3.0
      );

      // Override 3.0x should take precedence over default 2.0x
      expect(config.gasLimit).toBe(BigInt(300_000));
    });

    it("should use override multiplier even for time-sensitive triggers", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
        gasLimitMultiplierConservative: 2.5,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(100_000),
        1,
        4.0
      );

      // Override 4.0x should take precedence over conservative 2.5x
      expect(config.gasLimit).toBe(BigInt(400_000));
    });

    it("should ignore override when zero", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        0
      );

      // Should fall back to default 2.0x
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should ignore override when negative", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        -1.5
      );

      // Should fall back to default 2.0x
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should ignore override when undefined", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        undefined
      );

      // Should fall back to default 2.0x
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should clamp override to max of 10x", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(100_000),
        1,
        50.0
      );

      // Should be clamped to 10x, not 50x
      expect(config.gasLimit).toBe(BigInt(1_000_000));
    });

    it("should handle NaN override gracefully", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        Number.NaN
      );

      // NaN is falsy, should fall back to default 2.0x
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should use override when between 0 and 1 (passes > 0 check but below intended minimum)", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        0.5
      );

      // 0.5 passes the > 0 check in calculateGasLimit, so it's used as-is
      // This means the gas limit is LESS than the estimate (100k * 0.5 = 50k)
      // Backend step handlers should clamp to >= 1.0 before passing to gas strategy
      expect(config.gasLimit).toBe(BigInt(50_000));
    });
  });

  describe("gas limit override (absolute)", () => {
    it("should use absolute gas limit override when provided", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(100_000),
        1,
        undefined,
        BigInt(500_000)
      );

      // Absolute override should be used directly, ignoring multiplier
      expect(config.gasLimit).toBe(BigInt(500_000));
    });

    it("should prefer absolute override over multiplier override", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(100_000),
        1,
        5.0,
        BigInt(300_000)
      );

      // Absolute override takes precedence
      expect(config.gasLimit).toBe(BigInt(300_000));
    });

    it("should ignore absolute override when zero", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        undefined,
        BigInt(0)
      );

      // Should fall back to default 2.0x multiplier
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should ignore absolute override when negative", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        1,
        undefined,
        BigInt(-1)
      );

      // Negative bigint is not > 0, should fall back to default 2.0x multiplier
      expect(config.gasLimit).toBe(BigInt(200_000));
    });

    it("should work with absolute override for time-sensitive triggers", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplierConservative: 2.5,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "event",
        BigInt(100_000),
        1,
        undefined,
        BigInt(150_000)
      );

      // Absolute override bypasses trigger-type-based multiplier selection
      expect(config.gasLimit).toBe(BigInt(150_000));
    });

    it("should still calculate fees normally when using absolute gas limit", async () => {
      const strategy = new AdaptiveGasStrategy();
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "manual",
        BigInt(100_000),
        1,
        undefined,
        BigInt(500_000)
      );

      // Gas limit is overridden but fees should still be calculated
      expect(config.gasLimit).toBe(BigInt(500_000));
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
      expect(config.maxPriorityFeePerGas).toBeGreaterThan(BigInt(0));
    });
  });

  describe("gas limit calculation precision", () => {
    it("should maintain precision for large gas estimates", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 2.0,
      });
      const provider = createMockProvider();

      const largeEstimate = BigInt("5000000"); // 5M gas
      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        largeEstimate,
        1
      );

      expect(config.gasLimit).toBe(BigInt("10000000")); // Exactly 2x
    });

    it("should handle fractional multipliers correctly", async () => {
      const strategy = new AdaptiveGasStrategy({
        gasLimitMultiplier: 1.5,
      });
      const provider = createMockProvider();

      const config = await strategy.getGasConfig(
        provider as unknown as import("ethers").Provider,
        "scheduled",
        BigInt(100_000),
        42_161 // Arbitrum uses 1.5x
      );

      expect(config.gasLimit).toBe(BigInt(150_000)); // Exactly 1.5x
    });
  });
});

describe("executeWithRetry types and config", () => {
  it("should have correct default retry config", () => {
    expect(DEFAULT_RETRY_CONFIG).toEqual({
      maxAttempts: 3,
      escalationFactor: 1.5,
      checkIntervalMs: 5000,
      stuckThresholdMs: 30_000,
    });
  });

  it("should expose TransactionStuckError class", () => {
    const error = new TransactionStuckError("0x123abc", 3);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TransactionStuckError");
    expect(error.txHash).toBe("0x123abc");
    expect(error.attempts).toBe(3);
    expect(error.message).toContain("stuck after 3 attempt(s)");
  });

  it("should have proper TransactionStuckError inheritance", () => {
    const error = new TransactionStuckError("0xabc123", 2);

    expect(error instanceof Error).toBe(true);
    expect(error.stack).toBeDefined();
    expect(error.message).toBe(
      "Transaction 0xabc123 stuck after 2 attempt(s). Consider manual intervention."
    );
  });

  it("should export executeWithRetry as a function", () => {
    expect(typeof executeWithRetry).toBe("function");
  });
});
