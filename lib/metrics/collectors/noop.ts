/**
 * No-op Metrics Collector
 *
 * Silent implementation for environments without metrics collection:
 * - Frontend/browser environments
 * - Testing environments
 * - Development when metrics are disabled
 */

import type { MetricsCollector } from "../types";

/**
 * No-op metrics collector that silently discards all metrics
 *
 * Use this in:
 * - Client-side code where console output is undesirable
 * - Unit tests where metric output would clutter test logs
 * - Environments where metrics collection is disabled
 */
export const noopMetricsCollector: MetricsCollector = {
  recordLatency: () => {
    /* noop */
  },
  incrementCounter: () => {
    /* noop */
  },
  recordError: () => {
    /* noop */
  },
  recordWarning: () => {
    /* noop */
  },
  setGauge: () => {
    /* noop */
  },
};
