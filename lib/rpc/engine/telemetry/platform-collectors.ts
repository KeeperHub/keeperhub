import { ErrorCategory, logSystemError } from "@/lib/logging";
import type {
  FailoverStateChangeCallback,
  RpcMetricsCollector,
} from "../../providers";
import type { SolanaRpcMetricsCollector } from "../../providers/solana";

let cachedEvmCollector: RpcMetricsCollector | undefined;
let cachedSolanaCollector: SolanaRpcMetricsCollector | undefined;
let cachedFailoverCallback: FailoverStateChangeCallback | undefined;

/** `METRICS_COLLECTOR` value that turns on the Prometheus collectors. */
const PROMETHEUS_COLLECTOR = "prometheus";

function isPrometheusEnabled(): boolean {
  return process.env.METRICS_COLLECTOR === PROMETHEUS_COLLECTOR;
}

/**
 * The collector behind KeeperHub's RPC series: Prometheus on the server,
 * console debug lines elsewhere.
 */
export async function getEvmMetricsCollector(): Promise<RpcMetricsCollector> {
  if (cachedEvmCollector) {
    return cachedEvmCollector;
  }
  if (isPrometheusEnabled()) {
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

export async function getSolanaMetricsCollector(): Promise<SolanaRpcMetricsCollector> {
  if (cachedSolanaCollector) {
    return cachedSolanaCollector;
  }
  if (isPrometheusEnabled()) {
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

/** Updates the per-chain "using fallback" gauge for KeeperHub endpoints. */
export async function getFailoverCallback(): Promise<FailoverStateChangeCallback> {
  if (cachedFailoverCallback) {
    return cachedFailoverCallback;
  }
  if (isPrometheusEnabled()) {
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

/**
 * Chain the platform gauge with a caller's own callback. A throwing gauge
 * update must not break the caller's notification.
 */
export function composeFailoverCallbacks(
  platform: FailoverStateChangeCallback,
  caller?: FailoverStateChangeCallback
): FailoverStateChangeCallback {
  return (chain, isUsingFallback, reason) => {
    try {
      platform(chain, isUsingFallback, reason);
    } catch (error) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Metrics] Metrics failover callback error",
        error
      );
    }
    caller?.(chain, isUsingFallback, reason);
  };
}
