/**
 * RPC Provider Factory
 *
 * Creates RpcProviderManager or SolanaProviderManager instances with proper
 * configuration resolved from user preferences or chain defaults.
 */

import {
  createRpcProviderManager,
  type FailoverStateChangeCallback,
  type RpcProviderManager,
} from "@/lib/rpc/providers";
import {
  createSolanaProviderManager,
  type SolanaFailoverStateChangeCallback,
  type SolanaProviderManager,
} from "@/lib/rpc/providers/solana";
import { resolveRpcConfig } from "./config-service";
import {
  composeFailoverCallbacks,
  getEvmMetricsCollector,
  getFailoverCallback,
  getSolanaMetricsCollector,
} from "./engine/telemetry/platform-collectors";
import { isSolanaChain } from "./solana-chains";

// Solana chain IDs (non-EVM). The set and the test live in ./solana-chains so
// callers that cannot take this module's graph (ethers, @solana/web3.js,
// safeFetch, the db client) can still ask; re-exported here so every existing
// caller and test mock keeps its import path.
export { isSolanaChain } from "./solana-chains";

export type GetProviderOptions = {
  chainId: number;
  userId?: string;
  onFailoverStateChange?: FailoverStateChangeCallback;
  // KEEP-137: Private mempool routing (Flashbots Protect). See resolveRpcConfig.
  usePrivateMempool?: boolean;
  strict?: boolean;
};

export type GetSolanaProviderOptions = {
  chainId: number;
  userId?: string;
  onFailoverStateChange?: SolanaFailoverStateChangeCallback;
};

/**
 * Get an RPC provider manager for a specific EVM chain
 *
 * Resolves configuration from user preferences or chain defaults,
 * then creates (or retrieves cached) RpcProviderManager instance.
 *
 * @throws Error if chain is a Solana chain (use getSolanaProvider instead)
 */
export async function getRpcProvider(
  options: GetProviderOptions
): Promise<RpcProviderManager> {
  const { chainId, userId, onFailoverStateChange, usePrivateMempool, strict } =
    options;

  if (isSolanaChain(chainId)) {
    throw new Error(
      `Chain ${chainId} is a Solana chain. Use getSolanaProvider() instead.`
    );
  }

  const [config, metricsCollector, failoverCallback] = await Promise.all([
    resolveRpcConfig(chainId, userId, { usePrivateMempool, strict }),
    getEvmMetricsCollector(),
    getFailoverCallback(),
  ]);

  if (!config) {
    throw new Error(`Chain ${chainId} not found or not enabled`);
  }

  return createRpcProviderManager({
    primaryRpcUrl: config.primaryRpcUrl,
    fallbackRpcUrl: config.fallbackRpcUrl,
    chainName: config.chainName,
    chainId,
    primaryIsPrivateRelay: config.primaryIsPrivateRelay,
    metricsCollector,
    onFailoverStateChange: composeFailoverCallbacks(
      failoverCallback,
      onFailoverStateChange
    ),
  });
}

/**
 * Get a Solana provider manager for a specific Solana chain
 *
 * Resolves configuration from user preferences or chain defaults,
 * then creates (or retrieves cached) SolanaProviderManager instance.
 *
 * @throws Error if chain is not a Solana chain (use getRpcProvider instead)
 */
export async function getSolanaProvider(
  options: GetSolanaProviderOptions
): Promise<SolanaProviderManager> {
  const { chainId, userId, onFailoverStateChange } = options;

  if (!isSolanaChain(chainId)) {
    throw new Error(
      `Chain ${chainId} is not a Solana chain. Use getRpcProvider() instead.`
    );
  }

  const [config, metricsCollector, failoverCallback] = await Promise.all([
    resolveRpcConfig(chainId, userId),
    getSolanaMetricsCollector(),
    getFailoverCallback(),
  ]);

  if (!config) {
    throw new Error(`Solana chain ${chainId} not found or not enabled`);
  }

  return createSolanaProviderManager({
    primaryRpcUrl: config.primaryRpcUrl,
    fallbackRpcUrl: config.fallbackRpcUrl,
    chainName: config.chainName,
    metricsCollector,
    onFailoverStateChange: composeFailoverCallbacks(
      failoverCallback,
      onFailoverStateChange
    ),
  });
}

/**
 * Get an RPC provider from explicit URLs (for testing or override scenarios).
 * Async to resolve the metrics collector dynamically.
 */
export async function getRpcProviderFromUrls(
  primaryRpcUrl: string,
  fallbackRpcUrl?: string,
  chainId?: number,
  chainName = "unknown"
): Promise<RpcProviderManager> {
  const [metricsCollector, failoverCallback] = await Promise.all([
    getEvmMetricsCollector(),
    getFailoverCallback(),
  ]);

  return createRpcProviderManager({
    primaryRpcUrl,
    fallbackRpcUrl,
    chainName,
    chainId,
    metricsCollector,
    onFailoverStateChange: failoverCallback,
  });
}

/**
 * Get a Solana provider from explicit URLs (for testing or override scenarios).
 * Async to resolve the metrics collector dynamically.
 */
export async function getSolanaProviderFromUrls(
  primaryRpcUrl: string,
  fallbackRpcUrl?: string,
  chainName = "solana"
): Promise<SolanaProviderManager> {
  const [metricsCollector, failoverCallback] = await Promise.all([
    getSolanaMetricsCollector(),
    getFailoverCallback(),
  ]);

  return createSolanaProviderManager({
    primaryRpcUrl,
    fallbackRpcUrl,
    chainName,
    metricsCollector,
    onFailoverStateChange: failoverCallback,
  });
}
