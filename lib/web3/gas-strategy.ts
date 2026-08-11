/**
 * Adaptive Gas Strategy for KeeperHub Web3 Operations
 *
 * Strategy is purely a function of observable chain state — NEVER trigger type:
 * - Network volatility (coefficient of variation of recent base fees) selects
 *   between conservative (high-buffer) and percentile-optimized fee paths.
 * - Chain-specific configurations (from database with hardcoded fallbacks)
 *   provide minimum priority-fee floors and gas-limit multipliers.
 *
 * Two workflows hitting the same contract on the same chain at the same moment
 * receive the same gas config regardless of how they were triggered (manual,
 * scheduled, webhook, event). This eliminates the manual-vs-webhook divergence
 * that surfaced in KEEP-384.
 *
 * @see docs/keeperhub/KEEP-1240/gas.md for full specification
 */

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import {
  ErrorCategory,
  logSystemWarn,
  logUserError,
  logWarn,
} from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";

/**
 * Route an RPC call through the failover-aware RpcProviderManager when one
 * is supplied; otherwise fall back to the raw provider. Centralised so every
 * RPC call path in this file has the same behavior — without this helper, a
 * primary-RPC failure inside fee estimation would not trigger failover even
 * if every other call in the same workflow does.
 *
 * KEEP-344 follow-up: prior to this helper, gas-strategy called the raw
 * ethers provider directly, so an Infura 402 (or similar) propagated as a
 * hard failure even when a working fallback was configured.
 */
async function runRpc<T>(
  rpcManager: RpcProviderManager | undefined,
  provider: ethers.Provider,
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>
): Promise<T> {
  if (rpcManager) {
    return await rpcManager.executeWithFailover(fn, "read");
  }
  return await fn(provider as ethers.JsonRpcProvider);
}

export type GasConfig = {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type VolatilityMetrics = {
  baseFees: bigint[];
  mean: bigint;
  stdDev: bigint;
  coefficientOfVariation: number;
  isVolatile: boolean;
};

export type GasStrategyConfig = {
  // Gas limit multiplier (uniform — was previously bumped for "time-sensitive"
  // triggers; that branching is gone, see file header).
  gasLimitMultiplier: number;

  // Volatility thresholds
  volatilityThreshold: number;

  // Percentiles for different volatility levels
  percentileLowVolatility: number;
  percentileHighVolatility: number;

  // Fee bounds (safety rails)
  minPriorityFeeGwei: number;
  maxPriorityFeeGwei: number;
  maxFeeMultiplier: number;

  // Block sample size
  volatilitySampleBlocks: number;
};

type ChainGasConfig = GasStrategyConfig;

const MAX_GAS_LIMIT_MULTIPLIER_OVERRIDE = 10;

const DEFAULT_CONFIG: GasStrategyConfig = {
  gasLimitMultiplier: 2.0,
  volatilityThreshold: 0.3,
  percentileLowVolatility: 60,
  percentileHighVolatility: 80,
  minPriorityFeeGwei: 0.1,
  maxPriorityFeeGwei: 500,
  maxFeeMultiplier: 2.0,
  volatilitySampleBlocks: 10,
};

/**
 * BigInt square root using Newton's method
 */
function bigIntSqrt(n: bigint): bigint {
  if (n < BigInt(0)) {
    throw new Error("Square root of negative number");
  }
  if (n < BigInt(2)) {
    return n;
  }

  let x = n;
  let y = (x + BigInt(1)) / BigInt(2);

  while (y < x) {
    x = y;
    y = (x + n / x) / BigInt(2);
  }

  return x;
}

/**
 * Parse gwei string to bigint wei
 */
function parseGwei(gwei: string | number): bigint {
  return ethers.parseUnits(gwei.toString(), "gwei");
}

/**
 * Measure network volatility from recent base fee history
 */
async function measureVolatility(
  provider: ethers.Provider,
  blockCount = 40,
  rpcManager?: RpcProviderManager
): Promise<VolatilityMetrics> {
  try {
    // Fetch fee history for last N blocks
    const history = await runRpc(rpcManager, provider, (p) =>
      p.send("eth_feeHistory", [
        `0x${blockCount.toString(16)}`,
        "latest",
        [], // No percentiles needed, just base fees
      ])
    );

    const baseFees = history.baseFeePerGas
      .slice(0, -1) // Last entry is for next block (prediction)
      .map((hex: string) => BigInt(hex));

    if (baseFees.length === 0) {
      return {
        baseFees: [],
        mean: BigInt(0),
        stdDev: BigInt(0),
        coefficientOfVariation: 0,
        isVolatile: false,
      };
    }

    // Calculate mean
    const sum = baseFees.reduce((a: bigint, b: bigint) => a + b, BigInt(0));
    const mean = sum / BigInt(baseFees.length);

    // Calculate standard deviation
    const squaredDiffs = baseFees.map((fee: bigint) => {
      const diff = fee > mean ? fee - mean : mean - fee;
      return diff * diff;
    });
    const variance =
      squaredDiffs.reduce((a: bigint, b: bigint) => a + b, BigInt(0)) /
      BigInt(baseFees.length);
    const stdDev = bigIntSqrt(variance);

    // Coefficient of variation (normalized measure)
    const cv =
      mean > BigInt(0) ? Number((stdDev * BigInt(1000)) / mean) / 1000 : 0;

    return {
      baseFees,
      mean,
      stdDev,
      coefficientOfVariation: cv,
      isVolatile: cv >= DEFAULT_CONFIG.volatilityThreshold,
    };
  } catch (error) {
    // If fee history fails (some chains don't support it), return non-volatile
    logWarn("[GasStrategy] Failed to fetch fee history", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      baseFees: [],
      mean: BigInt(0),
      stdDev: BigInt(0),
      coefficientOfVariation: 0,
      isVolatile: false,
    };
  }
}

/**
 * Get percentile-based fee estimation from recent blocks
 */
async function getPercentileFees(
  provider: ethers.Provider,
  blockCount: number,
  percentile: number,
  rpcManager?: RpcProviderManager
): Promise<{ baseFee: bigint; priorityFee: bigint }> {
  try {
    const history = await runRpc(rpcManager, provider, (p) =>
      p.send("eth_feeHistory", [
        `0x${blockCount.toString(16)}`,
        "latest",
        [percentile],
      ])
    );

    // Get latest base fee (for next block)
    const baseFee = BigInt(history.baseFeePerGas.at(-1));

    // Get percentile priority fee from rewards
    const rewards = history.reward
      .map((r: string[]) => BigInt(r[0]))
      .filter((r: bigint) => r > BigInt(0));

    if (rewards.length === 0) {
      // Fallback to default
      return { baseFee, priorityFee: parseGwei("1.5") };
    }

    // Sort and get actual percentile
    rewards.sort((a: bigint, b: bigint) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    });
    const index = Math.floor((rewards.length * percentile) / 100);
    const priorityFee = rewards[Math.min(index, rewards.length - 1)];

    return { baseFee, priorityFee };
  } catch (error) {
    // Fallback if fee history fails
    logWarn("[GasStrategy] Failed to get percentile fees", {
      error: error instanceof Error ? error.message : String(error),
    });
    const feeData = await runRpc(rpcManager, provider, (p) => p.getFeeData());
    return {
      baseFee: feeData.maxFeePerGas ?? parseGwei("50"),
      priorityFee: feeData.maxPriorityFeePerGas ?? parseGwei("1.5"),
    };
  }
}

export class AdaptiveGasStrategy {
  private readonly config: GasStrategyConfig;

  constructor(config: Partial<GasStrategyConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Get gas configuration for a transaction.
   *
   * Strategy is determined by chain state alone (volatility + chain config).
   * Trigger type is intentionally not an input — see file header.
   */
  async getGasConfig(
    provider: ethers.Provider,
    estimatedGas: bigint,
    chainId: number,
    gasLimitMultiplierOverride?: number,
    gasLimitOverride?: bigint,
    rpcManager?: RpcProviderManager,
    priorityFeeOverride?: bigint
  ): Promise<GasConfig> {
    // Apply chain-specific overrides (from DB with hardcoded fallback)
    const chainConfig = await this.getChainConfig(chainId);

    // Calculate gas limit with safety margin
    const gasLimit = this.calculateGasLimit(
      estimatedGas,
      chainConfig,
      gasLimitMultiplierOverride,
      gasLimitOverride
    );

    // Get fee configuration based on strategy
    const feeConfig = await this.calculateFees(
      provider,
      chainConfig,
      rpcManager
    );

    // Caller-supplied priority fee override (e.g. when the network's mempool
    // requires a tip above the configured chain floor). Bypasses clampPriorityFee.
    // Preserve the base-fee component of maxFeePerGas (computed maxFeePerGas
    // minus computed priority) and rebuild it with the override so the EIP-1559
    // invariant maxFeePerGas >= maxPriorityFeePerGas is maintained.
    if (priorityFeeOverride !== undefined && priorityFeeOverride > BigInt(0)) {
      const baseComponent =
        feeConfig.maxFeePerGas > feeConfig.maxPriorityFeePerGas
          ? feeConfig.maxFeePerGas - feeConfig.maxPriorityFeePerGas
          : BigInt(0);
      console.log(
        `[GasStrategy] Priority fee override: ${ethers.formatUnits(priorityFeeOverride, "gwei")} gwei (clamp bypassed)`
      );
      return {
        gasLimit,
        maxFeePerGas: baseComponent + priorityFeeOverride,
        maxPriorityFeePerGas: priorityFeeOverride,
      };
    }

    return {
      gasLimit,
      maxFeePerGas: feeConfig.maxFeePerGas,
      maxPriorityFeePerGas: feeConfig.maxPriorityFeePerGas,
    };
  }

  private calculateGasLimit(
    estimatedGas: bigint,
    chainConfig: ChainGasConfig,
    gasLimitMultiplierOverride?: number,
    gasLimitOverride?: bigint
  ): bigint {
    // If an absolute gas limit is provided, use it directly (no multiplication)
    if (gasLimitOverride !== undefined && gasLimitOverride > BigInt(0)) {
      console.log(
        `[GasStrategy] Using absolute gas limit override: ${gasLimitOverride.toString()}`
      );
      return gasLimitOverride;
    }

    let multiplier: number;
    if (gasLimitMultiplierOverride && gasLimitMultiplierOverride > 0) {
      multiplier = Math.min(
        gasLimitMultiplierOverride,
        MAX_GAS_LIMIT_MULTIPLIER_OVERRIDE
      );
      console.log(`[GasStrategy] Using override multiplier: ${multiplier}x`);
    } else {
      multiplier = chainConfig.gasLimitMultiplier;
    }

    // Apply multiplier (using integer math with basis points)
    const multiplierBps = BigInt(Math.floor(multiplier * 10_000));
    return (estimatedGas * multiplierBps) / BigInt(10_000);
  }

  private async calculateFees(
    provider: ethers.Provider,
    chainConfig: ChainGasConfig,
    rpcManager?: RpcProviderManager
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    // Strategy is volatility-driven only — trigger type is intentionally not consulted.
    const volatility = await measureVolatility(
      provider,
      this.config.volatilitySampleBlocks,
      rpcManager
    );

    if (volatility.isVolatile) {
      console.log(
        `[GasStrategy] High volatility detected (CV=${volatility.coefficientOfVariation.toFixed(3)}), using conservative fees`
      );
      return this.getConservativeFees(provider, chainConfig, rpcManager);
    }

    // Low volatility - use percentile-based estimation
    return this.getOptimizedFees(provider, chainConfig, volatility, rpcManager);
  }

  private async getConservativeFees(
    provider: ethers.Provider,
    chainConfig: ChainGasConfig,
    rpcManager?: RpcProviderManager
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const feeData = await runRpc(rpcManager, provider, (p) => p.getFeeData());

    if (!(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas)) {
      // Fallback for non-EIP-1559 chains (legacy gas price)
      const gasPrice = feeData.gasPrice ?? parseGwei("50");
      return {
        maxFeePerGas: (gasPrice * BigInt(120)) / BigInt(100), // +20%
        maxPriorityFeePerGas: (gasPrice * BigInt(10)) / BigInt(100), // 10% as priority
      };
    }

    // Add 20% buffer to current network estimate
    const maxPriorityFeePerGas = this.clampPriorityFee(
      (feeData.maxPriorityFeePerGas * BigInt(120)) / BigInt(100),
      chainConfig
    );

    // Why "+ maxPriorityFeePerGas": EIP-1559 requires maxFeePerGas >= maxPriorityFeePerGas.
    // On low-base-fee chains (Sepolia/Arbitrum/Base in quiet windows), feeData.maxFeePerGas
    // can sit below the chain's clamped priority floor. Adding priority unconditionally
    // mirrors getOptimizedFees and preserves the invariant. KEEP-384.
    const networkBuffer = (feeData.maxFeePerGas * BigInt(120)) / BigInt(100);
    const maxFeePerGas = networkBuffer + maxPriorityFeePerGas;

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private async getOptimizedFees(
    provider: ethers.Provider,
    chainConfig: ChainGasConfig,
    volatility: VolatilityMetrics,
    rpcManager?: RpcProviderManager
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    // Use percentile based on volatility gradient
    const percentile = this.selectPercentile(volatility.coefficientOfVariation);

    const { baseFee, priorityFee } = await getPercentileFees(
      provider,
      this.config.volatilitySampleBlocks,
      percentile,
      rpcManager
    );

    const maxPriorityFeePerGas = this.clampPriorityFee(
      priorityFee,
      chainConfig
    );

    // Max fee = base fee * multiplier (account for base fee increases)
    const maxFeePerGas =
      (baseFee * BigInt(Math.floor(chainConfig.maxFeeMultiplier * 100))) /
        BigInt(100) +
      maxPriorityFeePerGas;

    console.log(
      `[GasStrategy] Optimized fees: percentile=${percentile}, ` +
        `baseFee=${ethers.formatUnits(baseFee, "gwei")}gwei, ` +
        `priorityFee=${ethers.formatUnits(maxPriorityFeePerGas, "gwei")}gwei`
    );

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private selectPercentile(cv: number): number {
    // Gradient-based percentile selection
    if (cv < 0.15) {
      return 50; // Very stable
    }
    if (cv < 0.2) {
      return 60; // Stable
    }
    if (cv < 0.25) {
      return 70; // Moderate
    }
    return 80; // Elevated (but below threshold)
  }

  private clampPriorityFee(fee: bigint, chainConfig: ChainGasConfig): bigint {
    const min = parseGwei(chainConfig.minPriorityFeeGwei);
    const max = parseGwei(chainConfig.maxPriorityFeeGwei);

    if (fee < min) {
      return min;
    }
    if (fee > max) {
      return max;
    }
    return fee;
  }

  /**
   * Get chain-specific gas configuration.
   * Fetches from database first, falls back to hardcoded defaults.
   */
  private async getChainConfig(chainId: number): Promise<ChainGasConfig> {
    // Try to fetch from database
    try {
      const chain = await db
        .select({ gasConfig: chains.gasConfig })
        .from(chains)
        .where(eq(chains.chainId, chainId))
        .limit(1);

      if (chain.length > 0 && chain[0].gasConfig) {
        const dbConfig = chain[0].gasConfig as Partial<ChainGasConfig>;
        // Merge: default config < hardcoded overrides < database config
        return {
          ...this.config,
          ...this.getHardcodedOverrides(chainId),
          ...dbConfig,
        } as ChainGasConfig;
      }
    } catch (error) {
      // Database unavailable, fall back to hardcoded
      logSystemWarn(
        ErrorCategory.DATABASE,
        "[GasStrategy] Failed to fetch chain config from DB",
        error,
        { chain_id: String(chainId) }
      );
    }

    // Fall back to hardcoded overrides
    return {
      ...this.config,
      ...this.getHardcodedOverrides(chainId),
    } as ChainGasConfig;
  }

  /**
   * Hardcoded chain-specific overrides (fallback when DB unavailable)
   */
  private getHardcodedOverrides(chainId: number): Partial<ChainGasConfig> {
    const overrides: Record<number, Partial<ChainGasConfig>> = {
      // Ethereum mainnet
      1: {
        gasLimitMultiplier: 2.0,
        minPriorityFeeGwei: 0.5,
      },
      // Sepolia testnet
      11155111: {
        gasLimitMultiplier: 2.0,
        minPriorityFeeGwei: 0.1,
      },
      // Arbitrum One
      42161: {
        gasLimitMultiplier: 1.5, // L2 estimates are more accurate
        minPriorityFeeGwei: 0.01,
        maxPriorityFeeGwei: 10,
      },
      // Arbitrum Sepolia
      421614: {
        gasLimitMultiplier: 1.5,
        minPriorityFeeGwei: 0.01,
        maxPriorityFeeGwei: 10,
      },
      // Base
      8453: {
        gasLimitMultiplier: 1.5,
        minPriorityFeeGwei: 0.001,
        maxPriorityFeeGwei: 5,
      },
      // Base Sepolia
      84532: {
        gasLimitMultiplier: 1.5,
        minPriorityFeeGwei: 0.001,
        maxPriorityFeeGwei: 5,
      },
      // Polygon
      137: {
        gasLimitMultiplier: 2.0,
        minPriorityFeeGwei: 30, // Polygon has higher base priority fees
        maxPriorityFeeGwei: 1000,
      },
      // Polygon Amoy testnet
      80002: {
        gasLimitMultiplier: 2.0,
        minPriorityFeeGwei: 30,
        maxPriorityFeeGwei: 1000,
      },
      // 0G Galileo testnet. The mempool admits tips at 2 gwei (matching the
      // node's "needed 2 gwei" floor) but validators only include txs paying
      // >= ~4 gwei. Validated 2026-05-01: sampled 10k recent blocks (400 txs);
      // 77% paid exactly 4.0 gwei, 91% paid >= 4.0, eth_maxPriorityFeePerGas
      // returns 4.0. A 2 gwei tip clears mempool admission then sits unmined
      // indefinitely. If 0G validator policy shifts (mempool floor != inclusion
      // floor is the trap), re-sample and adjust this entry.
      16602: {
        gasLimitMultiplier: 2.0,
        minPriorityFeeGwei: 4.0,
        maxPriorityFeeGwei: 500,
      },
      // 0G Mainnet -- mirrors Galileo's tip-cap requirement (same client/protocol).
      // If mainnet's actual floor differs, narrow this entry; defensive default
      // until we have mainnet-specific signal.
      16661: {
        gasLimitMultiplier: 2.0,
        minPriorityFeeGwei: 4.0,
        maxPriorityFeeGwei: 500,
      },
      // Tempo mainnet -- fees paid in a TIP-20 stablecoin, estimates are
      // accurate, so an L2-like 1.5x limit multiplier is enough headroom.
      4217: {
        gasLimitMultiplier: 1.5,
      },
      // Tempo Moderato testnet
      42431: {
        gasLimitMultiplier: 1.5,
      },
    };

    return overrides[chainId] || {};
  }
}

// ============================================================================
// Retry Escalation Strategy
// ============================================================================

/**
 * Configuration for transaction retry with gas escalation
 */
export type RetryConfig = {
  maxAttempts: number;
  escalationFactor: number; // Multiply priority fee by this each retry
  checkIntervalMs: number; // Time between confirmation checks
  stuckThresholdMs: number; // Time before considering tx stuck
};

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  escalationFactor: 1.5,
  checkIntervalMs: 5000,
  stuckThresholdMs: 30_000,
};

/**
 * Error thrown when a transaction is stuck after max retry attempts
 */
export class TransactionStuckError extends Error {
  readonly txHash: string;
  readonly attempts: number;

  constructor(txHash: string, attempts: number) {
    super(
      `Transaction ${txHash} stuck after ${attempts} attempt(s). Consider manual intervention.`
    );
    this.name = "TransactionStuckError";
    this.txHash = txHash;
    this.attempts = attempts;
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for transaction confirmation with timeout
 */
async function waitForConfirmation(
  tx: ethers.TransactionResponse,
  config: RetryConfig
): Promise<ethers.TransactionReceipt | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < config.stuckThresholdMs) {
    try {
      // Try to get receipt directly
      const receipt = await tx.provider?.getTransactionReceipt(tx.hash);
      if (receipt?.blockNumber) {
        return receipt;
      }
    } catch (_error) {
      // Receipt not available yet, continue waiting
    }

    await sleep(config.checkIntervalMs);
  }

  return null; // Timed out
}

/**
 * Execute a transaction with automatic retry and gas escalation
 *
 * When a transaction is stuck in the mempool, this function will:
 * 1. Wait for confirmation up to stuckThresholdMs
 * 2. If stuck, send a replacement transaction with higher gas (same nonce)
 * 3. Repeat up to maxAttempts times
 *
 * @param signer - Wallet/signer to send transaction
 * @param txRequest - Transaction request (must include nonce for replacement)
 * @param config - Retry configuration
 * @returns Transaction receipt on success
 * @throws TransactionStuckError if all attempts fail
 */
export async function executeWithRetry(
  signer: ethers.Signer,
  txRequest: ethers.TransactionRequest,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<ethers.TransactionReceipt> {
  let lastTxHash = "";
  let currentPriorityFee = txRequest.maxPriorityFeePerGas as bigint;
  let currentMaxFee = txRequest.maxFeePerGas as bigint;

  // Ensure nonce is set for replacement transactions
  if (txRequest.nonce === undefined) {
    txRequest.nonce = await signer.getNonce("pending");
  }

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Escalate gas price for retries (replacement transaction)
    if (attempt > 1) {
      const escalationBps = BigInt(Math.floor(config.escalationFactor * 100));
      currentPriorityFee = (currentPriorityFee * escalationBps) / BigInt(100);
      currentMaxFee = (currentMaxFee * escalationBps) / BigInt(100);

      txRequest.maxPriorityFeePerGas = currentPriorityFee;
      txRequest.maxFeePerGas = currentMaxFee;

      console.log(
        `[GasStrategy] Retry attempt ${attempt}, escalating priority fee to ${ethers.formatUnits(currentPriorityFee, "gwei")} gwei`
      );
    }

    // Send transaction
    const tx = await signer.sendTransaction(txRequest);
    lastTxHash = tx.hash;

    console.log(
      `[GasStrategy] Transaction sent: ${tx.hash} (attempt ${attempt}/${config.maxAttempts})`
    );

    // Wait for confirmation with timeout
    const receipt = await waitForConfirmation(tx, config);

    if (receipt) {
      console.log(
        `[GasStrategy] Transaction confirmed: ${tx.hash}, ` +
          `gasUsed=${receipt.gasUsed.toString()} ` +
          `(${((Number(receipt.gasUsed) / Number(txRequest.gasLimit || receipt.gasUsed)) * 100).toFixed(1)}% of limit)`
      );
      return receipt;
    }

    // Transaction stuck - will retry with higher gas (replacement)
    logUserError(
      ErrorCategory.TRANSACTION,
      `[GasStrategy] Transaction ${tx.hash} stuck after ${config.stuckThresholdMs}ms`,
      undefined,
      {
        tx_hash: tx.hash,
        stuck_threshold_ms: String(config.stuckThresholdMs),
      }
    );
  }

  throw new TransactionStuckError(lastTxHash, config.maxAttempts);
}

// ============================================================================
// Singleton & Exports
// ============================================================================

// Singleton instance
let instance: AdaptiveGasStrategy | null = null;

export function getGasStrategy(
  config?: Partial<GasStrategyConfig>
): AdaptiveGasStrategy {
  if (!instance) {
    instance = new AdaptiveGasStrategy(config);
  }
  return instance;
}

// Reset singleton (for testing)
export function resetGasStrategy(): void {
  instance = null;
}
