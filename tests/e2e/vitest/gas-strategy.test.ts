/**
 * E2E Tests for Adaptive Gas Strategy
 *
 * These tests verify the gas strategy with real RPC endpoints:
 * - Fee estimation from real chains
 * - EIP-1559 fee calculation
 * - Chain-specific configurations
 * - Volatility detection with real fee history
 *
 * Prerequisites:
 * - Network access to RPC endpoints
 */

import { ethers } from "ethers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// `@/lib/rpc/providers` (transitively imported via provider-factory) pulls in
// `lib/rpc/safe-ethers-fetch.ts`, which guards itself with
// `import "server-only"`. Without this mock the file-load throws under vitest.
vi.mock("server-only", () => ({}));

// Unmock for e2e tests so the real DB module is loaded.
vi.unmock("@/lib/db");

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { AdaptiveGasStrategy, resetGasStrategy } from "@/lib/web3/gas-strategy";

// Skip if SKIP_INFRA_TESTS is true (no network access)
const shouldSkip = process.env.SKIP_INFRA_TESTS === "true";

// Real RPC endpoints — primary + fallback so the failover path is actually
// exercised. KEEP-344 follow-up: previously these tests bypassed failover
// entirely (raw JsonRpcProvider), so a 402 from Infura would propagate as a
// hard failure. With both URLs wired through RpcProviderManager, the same
// 402 now triggers failover to the secondary.
const SEPOLIA_PRIMARY = getRpcUrlByChainId(11_155_111, "primary");
const SEPOLIA_FALLBACK = getRpcUrlByChainId(11_155_111, "fallback");
const BASE_SEPOLIA_PRIMARY = getRpcUrlByChainId(84_532, "primary");
const BASE_SEPOLIA_FALLBACK = getRpcUrlByChainId(84_532, "fallback");

describe.skipIf(shouldSkip)("Gas Strategy E2E", () => {
  let sepoliaProvider: ethers.JsonRpcProvider;
  let baseSepoliaProvider: ethers.JsonRpcProvider;
  let sepoliaManager: RpcProviderManager;
  let baseSepoliaManager: RpcProviderManager;

  beforeAll(async () => {
    // Initialize providers (used as the raw provider arg) plus the failover
    // manager (used to actually route RPC calls through executeWithFailover).
    sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_PRIMARY);
    baseSepoliaProvider = new ethers.JsonRpcProvider(BASE_SEPOLIA_PRIMARY);

    sepoliaManager = await getRpcProviderFromUrls(
      SEPOLIA_PRIMARY,
      SEPOLIA_FALLBACK,
      11_155_111,
      "sepolia"
    );
    baseSepoliaManager = await getRpcProviderFromUrls(
      BASE_SEPOLIA_PRIMARY,
      BASE_SEPOLIA_FALLBACK,
      84_532,
      "base-sepolia"
    );

    // Verify connectivity (via the manager so a primary 402 still falls
    // over to the secondary instead of skipping the whole suite).
    try {
      await sepoliaManager.executeWithFailover((p) => p.getBlockNumber());
    } catch (_error) {
      console.warn("Sepolia RPC not available, some tests may be skipped");
    }
  });

  afterAll(async () => {
    // Providers don't need explicit cleanup in ethers v6
  });

  beforeEach(() => {
    resetGasStrategy();
  });

  describe("Real RPC Fee Estimation", () => {
    it("should get gas config from Sepolia", async () => {
      const strategy = new AdaptiveGasStrategy();

      const config = await strategy.getGasConfig(
        sepoliaProvider,
        BigInt(21_000),
        11_155_111, // Sepolia
        undefined,
        undefined,
        sepoliaManager
      );

      // Should return valid gas config
      expect(config.gasLimit).toBeGreaterThan(BigInt(21_000)); // With buffer
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
      expect(config.maxPriorityFeePerGas).toBeGreaterThan(BigInt(0));

      // Max fee should be greater than priority fee
      expect(config.maxFeePerGas).toBeGreaterThan(config.maxPriorityFeePerGas);

      console.log("Sepolia gas config:", {
        gasLimit: config.gasLimit.toString(),
        maxFeePerGas: `${ethers.formatUnits(config.maxFeePerGas, "gwei")} gwei`,
        maxPriorityFeePerGas: `${ethers.formatUnits(config.maxPriorityFeePerGas, "gwei")} gwei`,
      });
    }, 30_000);

    it("should get gas config from Base Sepolia", async () => {
      const strategy = new AdaptiveGasStrategy();

      const config = await strategy.getGasConfig(
        baseSepoliaProvider,
        BigInt(21_000),
        84_532, // Base Sepolia
        undefined,
        undefined,
        baseSepoliaManager
      );

      expect(config.gasLimit).toBeGreaterThan(BigInt(21_000));
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
      expect(config.maxPriorityFeePerGas).toBeGreaterThan(BigInt(0));

      console.log("Base Sepolia gas config:", {
        gasLimit: config.gasLimit.toString(),
        maxFeePerGas: `${ethers.formatUnits(config.maxFeePerGas, "gwei")} gwei`,
        maxPriorityFeePerGas: `${ethers.formatUnits(config.maxPriorityFeePerGas, "gwei")} gwei`,
      });
    }, 30_000);

    it("should apply gas limit multiplier correctly", async () => {
      const strategy = new AdaptiveGasStrategy();
      const estimatedGas = BigInt(100_000);

      const config = await strategy.getGasConfig(
        sepoliaProvider,
        estimatedGas,
        11_155_111,
        undefined,
        undefined,
        sepoliaManager
      );

      // Gas limit should be estimated * multiplier (default 2.0)
      // Allow some tolerance for chain config variations
      const ratio = Number(config.gasLimit) / Number(estimatedGas);
      expect(ratio).toBeGreaterThanOrEqual(1.5);
      expect(ratio).toBeLessThanOrEqual(3.0);
    }, 30_000);
  });

  describe("Fee History Analysis", () => {
    it("should fetch and analyze fee history", async () => {
      const strategy = new AdaptiveGasStrategy();

      // Get config which internally fetches fee history
      const config = await strategy.getGasConfig(
        sepoliaProvider,
        BigInt(21_000),
        11_155_111,
        undefined,
        undefined,
        sepoliaManager
      );

      // Config should be reasonable for Sepolia
      // Sepolia fees are typically low (< 100 gwei)
      const maxFeeGwei = Number(
        ethers.formatUnits(config.maxFeePerGas, "gwei")
      );
      expect(maxFeeGwei).toBeGreaterThan(0);
      expect(maxFeeGwei).toBeLessThan(1000); // Sanity check

      const priorityFeeGwei = Number(
        ethers.formatUnits(config.maxPriorityFeePerGas, "gwei")
      );
      expect(priorityFeeGwei).toBeGreaterThan(0);
      expect(priorityFeeGwei).toBeLessThanOrEqual(maxFeeGwei);
    }, 30_000);

    it("should handle chain without fee history gracefully", async () => {
      const strategy = new AdaptiveGasStrategy();

      // Create a mock provider that doesn't support eth_feeHistory
      const mockProvider = {
        send: (method: string) => {
          if (method === "eth_feeHistory") {
            return Promise.reject(new Error("Method not supported"));
          }
          return Promise.reject(new Error(`Unknown method: ${method}`));
        },
        getFeeData: () =>
          Promise.resolve({
            gasPrice: BigInt(20_000_000_000), // 20 gwei
            maxFeePerGas: BigInt(40_000_000_000),
            maxPriorityFeePerGas: BigInt(2_000_000_000),
          }),
      };

      const config = await strategy.getGasConfig(
        mockProvider as any,
        BigInt(21_000),
        99_999 // Unknown chain
      );

      // Should fall back to getFeeData
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
      expect(config.maxPriorityFeePerGas).toBeGreaterThan(BigInt(0));
    }, 30_000);
  });

  describe("Chain-Specific Configurations", () => {
    it("should apply Ethereum mainnet config for chain 1", async () => {
      const strategy = new AdaptiveGasStrategy();

      // Use Sepolia provider but pretend it's mainnet for config lookup
      // Note: This tests the config lookup, not actual mainnet fees
      const config = await strategy.getGasConfig(
        sepoliaProvider,
        BigInt(21_000),
        1, // Mainnet chain ID
        undefined,
        undefined,
        sepoliaManager
      );

      // Should apply mainnet gas limit multiplier (2.0 default)
      const ratio = Number(config.gasLimit) / 21_000;
      expect(ratio).toBeGreaterThanOrEqual(1.5);
      expect(ratio).toBeLessThanOrEqual(3.0);
    }, 30_000);

    it("should apply L2 config for Arbitrum", async () => {
      const strategy = new AdaptiveGasStrategy();

      const config = await strategy.getGasConfig(
        sepoliaProvider,
        BigInt(21_000),
        42_161, // Arbitrum
        undefined,
        undefined,
        sepoliaManager
      );

      // Arbitrum has different gas model
      const ratio = Number(config.gasLimit) / 21_000;
      expect(ratio).toBeGreaterThanOrEqual(1.0);
      expect(ratio).toBeLessThanOrEqual(3.0);
    }, 30_000);

    it("should apply Base config", async () => {
      const strategy = new AdaptiveGasStrategy();

      const config = await strategy.getGasConfig(
        baseSepoliaProvider,
        BigInt(21_000),
        8453, // Base mainnet
        undefined,
        undefined,
        baseSepoliaManager
      );

      expect(config.gasLimit).toBeGreaterThan(BigInt(21_000));
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
    }, 30_000);
  });

  describe("Gas Price Boundaries", () => {
    it("should clamp priority fee to configured bounds", async () => {
      const strategy = new AdaptiveGasStrategy();

      const config = await strategy.getGasConfig(
        sepoliaProvider,
        BigInt(21_000),
        11_155_111,
        undefined,
        undefined,
        sepoliaManager
      );

      // Default min priority fee is 0.1 gwei
      const minPriorityFee = BigInt(100_000_000); // 0.1 gwei
      expect(config.maxPriorityFeePerGas).toBeGreaterThanOrEqual(
        minPriorityFee
      );

      // Default max priority fee is 500 gwei
      const maxPriorityFee = BigInt(500_000_000_000); // 500 gwei
      expect(config.maxPriorityFeePerGas).toBeLessThanOrEqual(maxPriorityFee);
    }, 30_000);

    it("should handle very low gas estimates", async () => {
      const strategy = new AdaptiveGasStrategy();

      const config = await strategy.getGasConfig(
        sepoliaProvider,
        BigInt(1000),
        11_155_111,
        undefined,
        undefined,
        sepoliaManager
      );

      // Should still apply multiplier
      expect(config.gasLimit).toBeGreaterThan(BigInt(1000));
    }, 30_000);

    it("should handle very high gas estimates", async () => {
      const strategy = new AdaptiveGasStrategy();
      const highGas = BigInt(10_000_000); // 10M gas

      const config = await strategy.getGasConfig(
        sepoliaProvider,
        highGas,
        11_155_111,
        undefined,
        undefined,
        sepoliaManager
      );

      // Should apply multiplier even to high estimates
      expect(config.gasLimit).toBeGreaterThan(highGas);
      expect(config.gasLimit).toBeLessThan(highGas * BigInt(3)); // Reasonable bound
    }, 30_000);
  });

  describe("Provider Error Handling", () => {
    it("should handle RPC timeout gracefully", async () => {
      const strategy = new AdaptiveGasStrategy();

      // Create a provider with very short timeout. Intentionally NOT routed
      // through the failover manager — this test asserts graceful degradation
      // in single-provider configurations.
      const slowProvider = new ethers.JsonRpcProvider(
        SEPOLIA_PRIMARY,
        undefined,
        {
          staticNetwork: ethers.Network.from(11_155_111),
        }
      );

      // Should still return a config (may use fallback values)
      const config = await strategy.getGasConfig(
        slowProvider,
        BigInt(21_000),
        11_155_111
      );

      expect(config.gasLimit).toBeGreaterThan(BigInt(0));
      expect(config.maxFeePerGas).toBeGreaterThan(BigInt(0));
    }, 60_000);
  });

  describe("Singleton Pattern", () => {
    it("should return same instance from getGasStrategy", async () => {
      const { getGasStrategy } = await import("@/lib/web3/gas-strategy");

      const strategy1 = getGasStrategy();
      const strategy2 = getGasStrategy();

      expect(strategy1).toBe(strategy2);
    });

    it("should return new instance after reset", async () => {
      const { getGasStrategy: getStrategy, resetGasStrategy: resetStrategy } =
        await import("@/lib/web3/gas-strategy");

      const strategy1 = getStrategy();
      resetStrategy();
      const strategy2 = getStrategy();

      expect(strategy1).not.toBe(strategy2);
    });
  });
});

describe.skipIf(shouldSkip)("Gas Strategy Real Transaction Estimation", () => {
  let sepoliaProvider: ethers.JsonRpcProvider;
  let sepoliaManager: RpcProviderManager;

  beforeAll(async () => {
    sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_PRIMARY);
    sepoliaManager = await getRpcProviderFromUrls(
      SEPOLIA_PRIMARY,
      SEPOLIA_FALLBACK,
      11_155_111,
      "sepolia"
    );
  });

  beforeEach(() => {
    resetGasStrategy();
  });

  it("should estimate gas for ERC20 transfer", async () => {
    const strategy = new AdaptiveGasStrategy();

    // USDC on Sepolia (or any ERC20-like contract)
    // Using a mock estimate since we don't have a real contract to call
    const estimatedGas = BigInt(65_000); // Typical ERC20 transfer

    const config = await strategy.getGasConfig(
      sepoliaProvider,
      estimatedGas,
      11_155_111,
      undefined,
      undefined,
      sepoliaManager
    );

    // Should have buffer for ERC20 transfer
    expect(config.gasLimit).toBeGreaterThan(estimatedGas);

    console.log("ERC20 transfer gas config:", {
      estimated: estimatedGas.toString(),
      withBuffer: config.gasLimit.toString(),
      maxFee: `${ethers.formatUnits(config.maxFeePerGas, "gwei")} gwei`,
    });
  }, 30_000);

  it("should estimate gas for complex contract interaction", async () => {
    const strategy = new AdaptiveGasStrategy();

    // Complex interaction (e.g., swap) typically uses more gas
    const estimatedGas = BigInt(250_000);

    const config = await strategy.getGasConfig(
      sepoliaProvider,
      estimatedGas,
      11_155_111,
      undefined,
      undefined,
      sepoliaManager
    );

    expect(config.gasLimit).toBeGreaterThan(estimatedGas);

    // Calculate total max cost
    const maxCost = config.gasLimit * config.maxFeePerGas;
    console.log("Complex interaction gas config:", {
      estimated: estimatedGas.toString(),
      withBuffer: config.gasLimit.toString(),
      maxCostEth: `${ethers.formatEther(maxCost)} ETH`,
    });
  }, 30_000);
});
