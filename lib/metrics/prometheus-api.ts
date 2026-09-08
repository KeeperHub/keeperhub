/**
 * Prometheus API Exports
 *
 * This module is ONLY imported by the /api/metrics route handler.
 * It is NOT safe to import from workflow code as it includes Node.js-only dependencies.
 *
 * @module prometheus-api
 */
import "server-only";

export {
  getApiProcessMetrics,
  getDbMetrics,
  getPrometheusContentType,
  getPrometheusMetrics,
  prometheusMetricsCollector,
  updateDbMetrics,
} from "./collectors/prometheus";
