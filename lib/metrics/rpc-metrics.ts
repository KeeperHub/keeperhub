/**
 * Prometheus-backed RPC metrics collectors for EVM and Solana providers.
 *
 * Implements RpcMetricsCollector and SolanaRpcMetricsCollector interfaces
 * from the rpc-provider modules, backed by Prometheus counters and gauges.
 *
 * Also provides an onFailoverStateChange callback that updates the
 * keeperhub_rpc_using_fallback gauge and records failover/recovery events.
 */

import "server-only";

import type {
  RpcErrorType,
  RpcMetricsCollector,
  RpcOperationType,
} from "@/lib/rpc/providers";
import type { SolanaRpcMetricsCollector } from "@/lib/rpc/providers/solana";
import { rpcMetrics } from "./collectors/prometheus";

/**
 * Prometheus-backed RPC metrics collector shared by EVM and Solana providers.
 * Both interfaces are structurally identical, so a single implementation serves both.
 */
const prometheusCollector: RpcMetricsCollector & SolanaRpcMetricsCollector = {
  recordPrimaryAttempt(
    chain: string,
    operation: RpcOperationType = "read"
  ): void {
    rpcMetrics.primaryAttempts.inc({ chain, operation });
  },
  recordPrimaryFailure(
    chain: string,
    operation: RpcOperationType = "read"
  ): void {
    rpcMetrics.primaryFailures.inc({ chain, operation });
  },
  recordFallbackAttempt(
    chain: string,
    operation: RpcOperationType = "read"
  ): void {
    rpcMetrics.fallbackAttempts.inc({ chain, operation });
  },
  recordFallbackFailure(
    chain: string,
    operation: RpcOperationType = "read"
  ): void {
    rpcMetrics.fallbackFailures.inc({ chain, operation });
  },
  recordFailoverEvent(chain: string): void {
    rpcMetrics.failoverEvents.inc({ chain });
  },
  recordRecoveryEvent(chain: string): void {
    rpcMetrics.recoveryEvents.inc({ chain });
  },
  recordBothFailed(chain: string): void {
    rpcMetrics.bothFailedEvents.inc({ chain });
    rpcMetrics.healthState.set({ chain }, 2);
  },
  recordSuccess(
    chain: string,
    provider: "primary" | "fallback",
    _operation?: RpcOperationType
  ): void {
    rpcMetrics.healthState.set({ chain }, provider === "primary" ? 0 : 1);
  },
  recordLatency(
    chain: string,
    provider: "primary" | "fallback",
    durationMs: number,
    operation: RpcOperationType = "read"
  ): void {
    rpcMetrics.latency.observe({ chain, provider, operation }, durationMs);
  },
  recordErrorType(
    chain: string,
    provider: "primary" | "fallback",
    errorType: RpcErrorType,
    operation: RpcOperationType = "read"
  ): void {
    rpcMetrics.errorsByType.inc({
      chain,
      provider,
      error_type: errorType,
      operation,
    });
  },
};

export const prometheusRpcMetricsCollector: RpcMetricsCollector =
  prometheusCollector;
export const prometheusSolanaRpcMetricsCollector: SolanaRpcMetricsCollector =
  prometheusCollector;

/**
 * Failover state change callback that updates Prometheus gauge and counters.
 * Pass this as the onFailoverStateChange callback to RpcProviderManager.
 */
export function onRpcFailoverStateChange(
  chain: string,
  isUsingFallback: boolean,
  _reason: "failover" | "recovery"
): void {
  rpcMetrics.currentProvider.set({ chain }, isUsingFallback ? 1 : 0);
}
