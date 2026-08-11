/**
 * Saturation Metrics Instrumentation
 *
 * Track resource utilization metrics for capacity planning and alerting.
 */

import { getMetricsCollector } from "../index";
import { MetricNames } from "../types";

/**
 * In-memory counter for concurrent workflow executions
 * Note: This is per-instance, not cluster-wide
 */
let concurrentExecutions = 0;

/**
 * Increment concurrent execution count and emit gauge
 */
export function incrementConcurrentExecutions(): void {
  concurrentExecutions += 1;
  emitConcurrentExecutionsGauge();
}

/**
 * Decrement concurrent execution count and emit gauge
 */
export function decrementConcurrentExecutions(): void {
  concurrentExecutions = Math.max(0, concurrentExecutions - 1);
  emitConcurrentExecutionsGauge();
}

/**
 * Get current concurrent execution count
 */
export function getConcurrentExecutions(): number {
  return concurrentExecutions;
}

/**
 * Reset concurrent executions (for testing)
 */
export function resetConcurrentExecutions(): void {
  concurrentExecutions = 0;
}

/**
 * Emit current concurrent executions as a gauge metric
 */
function emitConcurrentExecutionsGauge(): void {
  const metrics = getMetricsCollector();
  metrics.setGauge(MetricNames.WORKFLOW_CONCURRENT_COUNT, concurrentExecutions);
}

/**
 * Track workflow queue depth (if available).
 * Sourced from the Workflow DevKit runtime or a custom queue implementation.
 */
export function recordQueueDepth(depth: number): void {
  const metrics = getMetricsCollector();
  metrics.setGauge(MetricNames.WORKFLOW_QUEUE_DEPTH, depth);
}

/**
 * Track database pool utilization
 * Note: Requires access to the connection pool stats
 */
export function recordDbPoolUtilization(options: {
  activeConnections: number;
  maxConnections: number;
}): void {
  const metrics = getMetricsCollector();
  const utilization =
    options.maxConnections > 0
      ? (options.activeConnections / options.maxConnections) * 100
      : 0;

  metrics.setGauge(MetricNames.DB_POOL_UTILIZATION, utilization, {
    active: String(options.activeConnections),
    max: String(options.maxConnections),
  });
}

/**
 * Track slow database queries
 */
export function recordSlowQuery(durationMs: number, query?: string): void {
  const metrics = getMetricsCollector();

  if (durationMs > 100) {
    // Threshold for "slow" query
    metrics.incrementCounter(MetricNames.DB_QUERY_SLOW_COUNT, {
      threshold: "100ms",
      ...(query && { query_type: categorizeQuery(query) }),
    });
  }
}

/**
 * Categorize query type for metrics (without exposing full query)
 */
function categorizeQuery(query: string): string {
  const normalized = query.trim().toLowerCase();
  if (normalized.startsWith("select")) {
    return "select";
  }
  if (normalized.startsWith("insert")) {
    return "insert";
  }
  if (normalized.startsWith("update")) {
    return "update";
  }
  if (normalized.startsWith("delete")) {
    return "delete";
  }
  return "other";
}

/**
 * Wrapper to track execution with concurrent count
 */
export async function withConcurrentTracking<T>(
  fn: () => Promise<T>
): Promise<T> {
  incrementConcurrentExecutions();
  try {
    return await fn();
  } finally {
    decrementConcurrentExecutions();
  }
}
