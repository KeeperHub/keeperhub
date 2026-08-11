/**
 * Golden Signal Metrics
 *
 * Application-level metrics for KeeperHub workflow execution,
 * user activity, and plugin operations.
 *
 * NOTE: This module is intentionally kept free of Node.js-only dependencies
 * (like prom-client) so it can be safely bundled in workflow code.
 * Prometheus-specific functionality is in ./prometheus-api.ts
 *
 * @example
 * ```typescript
 * import { getMetricsCollector } from "@/lib/metrics";
 * import { MetricNames, LabelKeys } from "@/lib/metrics/types";
 *
 * const metrics = getMetricsCollector();
 *
 * // Record workflow execution duration
 * metrics.recordLatency(
 *   MetricNames.WORKFLOW_EXECUTION_DURATION,
 *   1234,
 *   { [LabelKeys.WORKFLOW_ID]: "wf_123", [LabelKeys.STATUS]: "success" }
 * );
 *
 * // Increment execution counter
 * metrics.incrementCounter(
 *   MetricNames.WORKFLOW_EXECUTIONS_TOTAL,
 *   { [LabelKeys.TRIGGER_TYPE]: "webhook" }
 * );
 * ```
 */

import { consoleMetricsCollector } from "./collectors/console";
import { noopMetricsCollector } from "./collectors/noop";
import type { MetricsCollector } from "./types";

/**
 * Detect if running in a server environment
 */
function isServerEnvironment(): boolean {
  return typeof window === "undefined";
}

/**
 * Check if metrics are enabled via environment variable
 */
function isMetricsEnabled(): boolean {
  // Default to enabled in server environment
  const envValue = process.env.METRICS_ENABLED;
  if (envValue === undefined) {
    return isServerEnvironment();
  }
  return envValue === "true" || envValue === "1";
}

/**
 * Get metrics collector type from environment
 * METRICS_COLLECTOR can be: "console" (default), "prometheus", or "noop"
 *
 * Note: When "prometheus" is selected, this module still returns the console
 * collector for workflow code. The actual Prometheus metrics are collected
 * via the /api/metrics endpoint which imports the prometheus collector directly.
 */
function getMetricsCollectorType(): "console" | "prometheus" | "noop" {
  const envValue = process.env.METRICS_COLLECTOR;
  if (envValue === "prometheus") {
    return "prometheus";
  }
  if (envValue === "noop") {
    return "noop";
  }
  return "console";
}

/**
 * Singleton metrics collector instance using globalThis
 * This ensures the collector persists across module instances in Next.js bundling
 */
const globalForMetrics = globalThis as unknown as {
  metricsCollectorInstance: MetricsCollector | undefined;
};

/**
 * Get the metrics collector instance
 *
 * Returns based on METRICS_COLLECTOR env var:
 * - "prometheus": ConsoleMetricsCollector (JSON logs are scraped separately)
 * - "console" (default): ConsoleMetricsCollector (JSON structured logging)
 * - "noop": NoopMetricsCollector (silent)
 *
 * Falls back to NoopMetricsCollector in browser or when disabled.
 *
 * Note: For Prometheus, this returns console collector because the actual
 * Prometheus metrics are exposed via /api/metrics which uses the prometheus
 * collector directly. This architecture avoids bundling prom-client in workflow code.
 *
 * @returns MetricsCollector instance
 */
export function getMetricsCollector(): MetricsCollector {
  if (globalForMetrics.metricsCollectorInstance) {
    return globalForMetrics.metricsCollectorInstance;
  }

  if (!(isServerEnvironment() && isMetricsEnabled())) {
    globalForMetrics.metricsCollectorInstance = noopMetricsCollector;
    return globalForMetrics.metricsCollectorInstance;
  }

  const collectorType = getMetricsCollectorType();

  switch (collectorType) {
    case "prometheus":
      // For prometheus mode, use console collector in workflow code
      // The /api/metrics endpoint imports prometheus collector directly
      globalForMetrics.metricsCollectorInstance = consoleMetricsCollector;
      break;
    case "noop":
      globalForMetrics.metricsCollectorInstance = noopMetricsCollector;
      break;
    default:
      globalForMetrics.metricsCollectorInstance = consoleMetricsCollector;
      break;
  }

  return globalForMetrics.metricsCollectorInstance;
}

/**
 * Set a custom metrics collector (useful for testing or custom implementations)
 *
 * @param collector - Custom MetricsCollector implementation
 */
export function setMetricsCollector(collector: MetricsCollector): void {
  globalForMetrics.metricsCollectorInstance = collector;
}

/**
 * Reset the metrics collector to default behavior
 * Useful for testing cleanup
 */
export function resetMetricsCollector(): void {
  globalForMetrics.metricsCollectorInstance = undefined;
}

/**
 * Utility: Create a timer for measuring operation duration
 *
 * @example
 * ```typescript
 * const timer = createTimer();
 * await someOperation();
 * metrics.recordLatency("operation.duration_ms", timer());
 * ```
 */
export function createTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

/**
 * Utility: Wrap an async function with latency tracking
 *
 * @example
 * ```typescript
 * const result = await withLatencyTracking(
 *   () => executeWorkflow(id),
 *   MetricNames.WORKFLOW_EXECUTION_DURATION,
 *   { workflow_id: id }
 * );
 * ```
 */
export async function withLatencyTracking<T>(
  fn: () => Promise<T>,
  metricName: string,
  labels?: Record<string, string>
): Promise<T> {
  const metrics = getMetricsCollector();
  const timer = createTimer();

  try {
    const result = await fn();
    metrics.recordLatency(metricName, timer(), {
      ...labels,
      status: "success",
    });
    return result;
  } catch (error) {
    metrics.recordLatency(metricName, timer(), {
      ...labels,
      status: "failure",
    });
    throw error;
  }
}

/**
 * Utility: Wrap an async function with full metrics tracking (latency + errors)
 *
 * @example
 * ```typescript
 * const result = await withMetrics(
 *   () => executeWorkflow(id),
 *   {
 *     latencyMetric: MetricNames.WORKFLOW_EXECUTION_DURATION,
 *     errorMetric: MetricNames.WORKFLOW_EXECUTION_ERRORS,
 *     counterMetric: MetricNames.WORKFLOW_EXECUTIONS_TOTAL,
 *     labels: { workflow_id: id, trigger_type: "webhook" }
 *   }
 * );
 * ```
 */
export async function withMetrics<T>(
  fn: () => Promise<T>,
  options: {
    latencyMetric?: string;
    errorMetric?: string;
    counterMetric?: string;
    labels?: Record<string, string>;
  }
): Promise<T> {
  const metrics = getMetricsCollector();
  const timer = createTimer();
  const { latencyMetric, errorMetric, counterMetric, labels } = options;

  // Increment traffic counter if specified
  if (counterMetric) {
    metrics.incrementCounter(counterMetric, labels);
  }

  try {
    const result = await fn();

    if (latencyMetric) {
      metrics.recordLatency(latencyMetric, timer(), {
        ...labels,
        status: "success",
      });
    }

    return result;
  } catch (error) {
    if (latencyMetric) {
      metrics.recordLatency(latencyMetric, timer(), {
        ...labels,
        status: "failure",
      });
    }

    if (errorMetric && error instanceof Error) {
      metrics.recordError(errorMetric, error, labels);
    }

    throw error;
  }
}
