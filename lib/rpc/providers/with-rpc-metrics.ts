import type {
  RpcMetricsCollector,
  RpcOperationType,
  RpcProviderManager,
} from "./index";
import { classifyRpcError } from "./index";

export type RpcMetricsContext = {
  metricsCollector: RpcMetricsCollector;
  chainName: string;
  providerType: "primary" | "fallback";
  operationType: RpcOperationType;
};

/**
 * Build an RpcMetricsContext from an RpcProviderManager instance.
 */
export function rpcMetricsCtx(
  rpcManager: RpcProviderManager,
  operationType: RpcOperationType = "write"
): RpcMetricsContext {
  return {
    metricsCollector: rpcManager.getMetricsCollector(),
    chainName: rpcManager.getChainName(),
    providerType: rpcManager.getCurrentProviderType(),
    operationType,
  };
}

/**
 * Wrap an RPC operation with metrics recording.
 * Records attempt, latency, success/failure, and error type.
 * Does NOT add failover or retries -- use executeWithFailover for that.
 * Re-throws the original error on failure.
 */
export async function withRpcMetrics<T>(
  ctx: RpcMetricsContext,
  operation: () => Promise<T>
): Promise<T> {
  const { metricsCollector, chainName, providerType, operationType } = ctx;

  if (providerType === "primary") {
    metricsCollector.recordPrimaryAttempt(chainName, operationType);
  } else {
    metricsCollector.recordFallbackAttempt(chainName, operationType);
  }

  const startTime = performance.now();
  try {
    const result = await operation();
    const durationMs = performance.now() - startTime;
    metricsCollector.recordLatency(
      chainName,
      providerType,
      durationMs,
      operationType
    );
    metricsCollector.recordSuccess(chainName, providerType, operationType);
    return result;
  } catch (error: unknown) {
    const durationMs = performance.now() - startTime;
    metricsCollector.recordLatency(
      chainName,
      providerType,
      durationMs,
      operationType
    );
    if (providerType === "primary") {
      metricsCollector.recordPrimaryFailure(chainName, operationType);
    } else {
      metricsCollector.recordFallbackFailure(chainName, operationType);
    }
    metricsCollector.recordErrorType(
      chainName,
      providerType,
      classifyRpcError(error),
      operationType
    );
    throw error;
  }
}
