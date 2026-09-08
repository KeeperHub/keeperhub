/**
 * Dual-Write Metrics Collector
 *
 * Writes metrics to both console (for CloudWatch/logs) and Prometheus (for scraping).
 * This is used when METRICS_COLLECTOR=prometheus to ensure metrics appear in both places.
 */

import type { ErrorContext, MetricLabels, MetricsCollector } from "../types";
import { consoleMetricsCollector } from "./console";

/**
 * Create a dual-write collector that sends metrics to both console and Prometheus
 *
 * @param prometheusCollector - The Prometheus collector to also write to
 */
export function createDualWriteCollector(
  prometheusCollector: MetricsCollector
): MetricsCollector {
  return {
    recordLatency(
      name: string,
      durationMs: number,
      labels?: MetricLabels
    ): void {
      // Write to console for CloudWatch/logs
      consoleMetricsCollector.recordLatency(name, durationMs, labels);
      // Write to Prometheus for scraping
      prometheusCollector.recordLatency(name, durationMs, labels);
    },

    incrementCounter(name: string, labels?: MetricLabels, value = 1): void {
      consoleMetricsCollector.incrementCounter(name, labels, value);
      prometheusCollector.incrementCounter(name, labels, value);
    },

    recordError(
      name: string,
      error: Error | ErrorContext,
      labels?: MetricLabels
    ): void {
      consoleMetricsCollector.recordError(name, error, labels);
      prometheusCollector.recordError(name, error, labels);
    },

    recordWarning(
      name: string,
      error: Error | ErrorContext,
      labels?: MetricLabels
    ): void {
      consoleMetricsCollector.recordWarning(name, error, labels);
      prometheusCollector.recordWarning(name, error, labels);
    },

    setGauge(name: string, value: number, labels?: MetricLabels): void {
      consoleMetricsCollector.setGauge(name, value, labels);
      prometheusCollector.setGauge(name, value, labels);
    },
  };
}
