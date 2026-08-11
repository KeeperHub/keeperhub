/**
 * RPC Provider Factory
 *
 * Creates RpcProviderManager or SolanaProviderManager instances with proper
 * configuration resolved from user preferences or chain defaults.
 */

import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  createRpcProviderManager,
  type FailoverStateChangeCallback,
  type RpcMetricsCollector,
  type RpcProviderManager,
} from "@/lib/rpc/providers";
import {
  createSolanaProviderManager,
  type SolanaFailoverStateChangeCallback,
  type SolanaProviderManager,
  type SolanaRpcMetricsCollector,
} from "@/lib/rpc/providers/solana";
import { resolveRpcConfig } from "./config-service";

/**
 * Resolve the appropriate RPC metrics collector based on environment.
 * Uses Prometheus when available (server-side), falls back to console.
 */
let cachedEvmCollector: RpcMetricsCollector | undefined;
let cachedSolanaCollector: SolanaRpcMetricsCollector | undefined;
let cachedFailoverCallback: FailoverStateChangeCallback | undefined;

async function getEvmMetricsCollector(): Promise<RpcMetricsCollector> {
  if (cachedEvmCollector) {
    return cachedEvmCollector;
  }

  if (process.env.METRICS_COLLECTOR === "prometheus") {
    const { prometheusRpcMetricsCollector } = await import(
      "@/lib/metrics/rpc-metrics"
    );
    cachedEvmCollector = prometheusRpcMetricsCollector;
  } else {
    const { consoleMetricsCollector } = await import("@/lib/rpc/providers");
    cachedEvmCollector = consoleMetricsCollector;
  }

  return cachedEvmCollector;
}

async function getSolanaMetricsCollector(): Promise<SolanaRpcMetricsCollector> {
  if (cachedSolanaCollector) {
    return cachedSolanaCollector;
  }

  if (process.env.METRICS_COLLECTOR === "prometheus") {
    const { prometheusSolanaRpcMetricsCollector } = await import(
      "@/lib/metrics/rpc-metrics"
    );
    cachedSolanaCollector = prometheusSolanaRpcMetricsCollector;
  } else {
    const { consoleSolanaMetricsCollector } = await import(
      "@/lib/rpc/providers/solana"
    );
    cachedSolanaCollector = consoleSolanaMetricsCollector;
  }

  return cachedSolanaCollector;
}

async function getFailoverCallback(): Promise<FailoverStateChangeCallback> {
  if (cachedFailoverCallback) {
    return cachedFailoverCallback;
  }

  if (process.env.METRICS_COLLECTOR === "prometheus") {
    const { onRpcFailoverStateChange } = await import(
      "@/lib/metrics/rpc-metrics"
    );
    cachedFailoverCallback = onRpcFailoverStateChange;
  } else {
    cachedFailoverCallback = () => {
      /* noop when prometheus is not enabled */
    };
  }

  return cachedFailoverCallback;
}

// Solana chain IDs (non-EVM)
const SOLANA_CHAIN_IDS = new Set([101, 103]);

/**
 * Check if a chain ID is a Solana chain
 */
export function isSolanaChain(chainId: number): boolean {
  return SOLANA_CHAIN_IDS.has(chainId);
}

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
    onFailoverStateChange: (chain, isUsingFallback, reason) => {
      try {
        failoverCallback(chain, isUsingFallback, reason);
      } catch (error) {
        logSystemError(
          ErrorCategory.INFRASTRUCTURE,
          "[Metrics] Metrics failover callback error",
          error
        );
      }
      onFailoverStateChange?.(chain, isUsingFallback, reason);
    },
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
    onFailoverStateChange: (chain, isUsingFallback, reason) => {
      try {
        failoverCallback(chain, isUsingFallback, reason);
      } catch (error) {
        logSystemError(
          ErrorCategory.INFRASTRUCTURE,
          "[Metrics] Metrics failover callback error",
          error
        );
      }
      onFailoverStateChange?.(chain, isUsingFallback, reason);
    },
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
