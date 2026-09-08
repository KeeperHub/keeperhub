/**
 * Console Metrics Collector
 *
 * Outputs structured JSON logs compatible with CloudWatch/Datadog.
 * Use for server-side metric collection.
 */

import { rawConsole } from "@/lib/log/core";
import type {
  ErrorContext,
  MetricEvent,
  MetricLabels,
  MetricsCollector,
} from "../types";

/**
 * Normalize labels to ensure all values are JSON-serializable
 */
function normalizeLabels(
  labels?: MetricLabels
): Record<string, string> | undefined {
  if (!labels) {
    return;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    normalized[key] = String(value);
  }
  return normalized;
}

/**
 * Extract error context from Error object or ErrorContext
 */
function extractErrorContext(error: Error | ErrorContext): ErrorContext {
  if (error instanceof Error) {
    const errorWithExtras = error as Error & { code?: string; cause?: unknown };
    return {
      code: errorWithExtras.code,
      message: error.message,
      stack: error.stack,
      cause: errorWithExtras.cause ? String(errorWithExtras.cause) : undefined,
    };
  }
  return error;
}

/**
 * Options for creating a metric event
 */
type CreateMetricEventOptions = {
  name: string;
  type: MetricEvent["metric"]["type"];
  value: number;
  labels?: MetricLabels;
  level?: MetricEvent["level"];
};

/**
 * Create a structured metric event
 */
function createMetricEvent(options: CreateMetricEventOptions): MetricEvent {
  const { name, type, value, labels, level = "info" } = options;
  return {
    timestamp: new Date().toISOString(),
    level,
    metric: {
      name,
      type,
      value,
      labels: normalizeLabels(labels),
    },
  };
}

/**
 * Emit a counter metric event for an error/warning. Same payload shape;
 * only the log level (and the console method) differ.
 */
function emitErrorEvent(
  level: "error" | "warn",
  name: string,
  error: Error | ErrorContext,
  labels?: MetricLabels
): void {
  const errorContext = extractErrorContext(error);
  const enrichedLabels: MetricLabels = {
    ...labels,
    error_message: errorContext.message,
    ...(errorContext.code && { error_code: errorContext.code }),
  };

  const event = createMetricEvent({
    name,
    type: "counter",
    value: 1,
    labels: enrichedLabels,
    level,
  });

  // Include full error context in a separate field for debugging
  const eventWithError = { ...event, error: errorContext };

  if (level === "error") {
    rawConsole.error(JSON.stringify(eventWithError));
  } else {
    rawConsole.warn(JSON.stringify(eventWithError));
  }
}

/**
 * Console-based metrics collector that outputs structured JSON
 *
 * Output format is compatible with CloudWatch Logs Insights and Datadog:
 * ```json
 * {
 *   "timestamp": "2024-01-13T10:30:00.000Z",
 *   "level": "info",
 *   "metric": {
 *     "name": "workflow.execution.duration_ms",
 *     "type": "histogram",
 *     "value": 1234,
 *     "labels": { "workflow_id": "wf_123", "status": "success" }
 *   }
 * }
 * ```
 */
export const consoleMetricsCollector: MetricsCollector = {
  recordLatency(name: string, durationMs: number, labels?: MetricLabels): void {
    const event = createMetricEvent({
      name,
      type: "histogram",
      value: durationMs,
      labels,
    });
    rawConsole.info(JSON.stringify(event));
  },

  incrementCounter(name: string, labels?: MetricLabels, value = 1): void {
    const event = createMetricEvent({ name, type: "counter", value, labels });
    rawConsole.info(JSON.stringify(event));
  },

  recordError(
    name: string,
    error: Error | ErrorContext,
    labels?: MetricLabels
  ): void {
    emitErrorEvent("error", name, error, labels);
  },

  recordWarning(
    name: string,
    error: Error | ErrorContext,
    labels?: MetricLabels
  ): void {
    emitErrorEvent("warn", name, error, labels);
  },

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    const event = createMetricEvent({ name, type: "gauge", value, labels });
    rawConsole.info(JSON.stringify(event));
  },
};

/**
 * Create a console collector with a custom prefix for namespacing
 */
export function createPrefixedConsoleCollector(
  prefix: string
): MetricsCollector {
  return {
    recordLatency(name, durationMs, labels) {
      consoleMetricsCollector.recordLatency(
        `${prefix}.${name}`,
        durationMs,
        labels
      );
    },
    incrementCounter(name, labels, value) {
      consoleMetricsCollector.incrementCounter(
        `${prefix}.${name}`,
        labels,
        value
      );
    },
    recordError(name, error, labels) {
      consoleMetricsCollector.recordError(`${prefix}.${name}`, error, labels);
    },
    recordWarning(name, error, labels) {
      consoleMetricsCollector.recordWarning(`${prefix}.${name}`, error, labels);
    },
    setGauge(name, value, labels) {
      consoleMetricsCollector.setGauge(`${prefix}.${name}`, value, labels);
    },
  };
}
