/**
 * Unified Logging + Metrics
 *
 * Provides two core functions that automatically log AND emit Prometheus metrics.
 * This ensures consistency and prevents metrics from being forgotten.
 *
 * Usage:
 * - logUserError(category, message, error, labels) - for user-caused errors (validation, config, external services, RPC, transactions)
 * - logSystemError(category, message, error, labels) - for system failures (database, auth, infrastructure, workflow engine)
 *
 * Every call automatically:
 * - Logs to console (warn for user errors, error for system errors)
 * - Emits a Prometheus metric with proper categorization
 * - Extracts context from message prefix (e.g., "[Discord]" → "Discord")
 * - Includes standard labels (error_category, error_context, is_user_error)
 *
 * @example
 * logUserError(ErrorCategory.VALIDATION, "[Check Balance] Invalid address:", address, { plugin_name: "web3" });
 * logUserError(ErrorCategory.EXTERNAL_SERVICE, "[Etherscan] API failed:", error, { service: "etherscan" });
 * logSystemError(ErrorCategory.DATABASE, "[DB] Insert failed:", error, { table: "workflows" });
 * logSystemError(ErrorCategory.INFRASTRUCTURE, "[Para] API key missing:", error, { component: "para-service" });
 */

import { captureException } from "@sentry/nextjs";
import { getMetricsCollector } from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import { getWorkflowErrorContext } from "@/lib/workflow-error-context";

/**
 * Labels that have unbounded cardinality and must NEVER be sent to Prometheus. They are kept in console output and Sentry extras for debugging.
 * Note: workflow_id is intentionally NOT in this set because the existing
 * keeperhub-errors-dashboard groups by it. workflow_id cardinality is bounded
 * by active workflows, which is acceptable.
 */
const HIGH_CARDINALITY_LABELS = new Set<string>([
  "execution_id",
  "org_id",
  "owner_id",
]);

function mergeLabels(
  labels: Record<string, string> | undefined
): Record<string, string> {
  const ctx = getWorkflowErrorContext();
  if (!ctx) {
    return { ...labels };
  }
  // Caller-provided labels win over ALS context.
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined) {
      merged[k] = v;
    }
  }
  return { ...merged, ...labels };
}

function stripHighCardinality(
  labels: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!HIGH_CARDINALITY_LABELS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function buildLogTag(labels: Record<string, string>): string {
  const parts: string[] = [];
  if (labels.org_slug) {
    parts.push(`org:${labels.org_slug}`);
  } else if (labels.org_id) {
    parts.push(`org:${labels.org_id}`);
  }
  if (labels.owner_id) {
    parts.push(`owner:${labels.owner_id}`);
  }
  if (labels.workflow_id) {
    parts.push(`wf:${labels.workflow_id}`);
  }
  if (labels.execution_id) {
    parts.push(`exec:${labels.execution_id}`);
  }
  return parts.length > 0 ? ` [${parts.join("][")}]` : "";
}

/**
 * Error/warning categories for metrics classification
 */
export const ErrorCategory = {
  // User-caused errors
  VALIDATION: "validation",
  CONFIGURATION: "configuration",
  EXTERNAL_SERVICE: "external_service",
  NETWORK_RPC: "network_rpc",
  TRANSACTION: "transaction",

  // System-caused errors
  DATABASE: "database",
  AUTH: "auth",
  INFRASTRUCTURE: "infrastructure",
  WORKFLOW_ENGINE: "workflow_engine",
  UNKNOWN: "unknown",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * Regex pattern for extracting context from message prefix (e.g., "[Discord]" → "Discord")
 */
const CONTEXT_PREFIX_REGEX = /^\[([^\]]+)\]/;

/**
 * Get metric name for error category
 */
function getMetricName(category: ErrorCategory): string {
  switch (category) {
    case ErrorCategory.VALIDATION:
      return MetricNames.USER_VALIDATION_ERRORS;
    case ErrorCategory.CONFIGURATION:
      return MetricNames.USER_CONFIGURATION_ERRORS;
    case ErrorCategory.EXTERNAL_SERVICE:
      return MetricNames.EXTERNAL_SERVICE_ERRORS;
    case ErrorCategory.NETWORK_RPC:
      return MetricNames.NETWORK_RPC_ERRORS;
    case ErrorCategory.TRANSACTION:
      return MetricNames.TRANSACTION_BLOCKCHAIN_ERRORS;
    case ErrorCategory.DATABASE:
      return MetricNames.SYSTEM_DATABASE_ERRORS;
    case ErrorCategory.AUTH:
      return MetricNames.SYSTEM_AUTH_ERRORS;
    case ErrorCategory.INFRASTRUCTURE:
      return MetricNames.SYSTEM_INFRASTRUCTURE_ERRORS;
    case ErrorCategory.WORKFLOW_ENGINE:
      return MetricNames.SYSTEM_WORKFLOW_ENGINE_ERRORS;
    default:
      return MetricNames.API_ERRORS_TOTAL;
  }
}

/**
 * Extract context prefix from message (e.g., "[Discord]" → "Discord")
 */
function extractContext(message: string): string {
  const match = message.match(CONTEXT_PREFIX_REGEX);
  return match ? match[1] : "Unknown";
}

/**
 * Log a user error/warning with automatic metrics
 *
 * User errors are logged as warnings (they don't wake up DevOps) and
 * automatically emit a Prometheus metric for tracking.
 *
 * @param category - Error category (validation, configuration, etc.)
 * @param message - Error message with [Context] prefix
 * @param error - Optional error details (object, Error instance, or string)
 * @param labels - Optional additional metric labels
 *
 * @example
 * logUserError(ErrorCategory.VALIDATION, "[Check Balance] Invalid address:", address, {
 *   plugin_name: "web3",
 *   action_name: "check-balance"
 * });
 */
export function logUserError(
  category: ErrorCategory,
  message: string,
  error?: unknown,
  labels?: Record<string, string>
): void {
  const metrics = getMetricsCollector();
  const context = extractContext(message);

  // Merge async-local workflow context (org/owner/workflow ids).
  const fullLabels = mergeLabels(labels);

  // Log as warning (user errors don't wake up DevOps)
  const tag = buildLogTag(fullLabels);
  console.warn(`${message}${tag}`, error ?? "");

  // Emit metric (high-cardinality labels stripped to protect Prometheus)
  const metricLabels = stripHighCardinality(fullLabels);
  metrics.recordError(
    getMetricName(category),
    error instanceof Error ? error : { message },
    {
      ...metricLabels,
      [LabelKeys.ERROR_CATEGORY]: category,
      [LabelKeys.ERROR_CONTEXT]: context,
      [LabelKeys.IS_USER_ERROR]: "true",
    }
  );

  // Report to Sentry as warning-level (user errors are tracked but don't alert)
  if (error !== undefined) {
    const sentryError =
      error instanceof Error ? error : new Error(String(error));
    captureException(sentryError, {
      level: "warning",
      tags: {
        error_category: category,
        error_context: context,
        is_user_error: "true",
      },
      extra: fullLabels,
    });
  }
}

/**
 * Log a system error with automatic metrics
 *
 * System errors are logged as errors (critical failures) and
 * automatically emit a Prometheus metric for tracking.
 *
 * @param category - Error category (database, auth, infrastructure, etc.)
 * @param message - Error message with [Context] prefix
 * @param error - Error object or details (required for system errors)
 * @param labels - Optional additional metric labels
 *
 * @example
 * logSystemError(ErrorCategory.DATABASE, "[API] Failed to insert workflow:", error, {
 *   endpoint: "/api/workflows",
 *   status_code: "500"
 * });
 */
export function logSystemError(
  category: ErrorCategory,
  message: string,
  error: unknown,
  labels?: Record<string, string>
): void {
  const metrics = getMetricsCollector();
  const context = extractContext(message);

  // Merge async-local workflow context (org/owner/workflow ids).
  const fullLabels = mergeLabels(labels);

  // Log as error (system failures are critical)
  const tag = buildLogTag(fullLabels);
  console.error(`${message}${tag}`, error);

  // Emit metric (high-cardinality labels stripped to protect Prometheus)
  const metricLabels = stripHighCardinality(fullLabels);
  metrics.recordError(
    getMetricName(category),
    error instanceof Error ? error : { message: String(error) },
    {
      ...metricLabels,
      [LabelKeys.ERROR_CATEGORY]: category,
      [LabelKeys.ERROR_CONTEXT]: context,
      [LabelKeys.IS_USER_ERROR]: "false",
    }
  );

  // Report to Sentry for alerting
  const sentryError = error instanceof Error ? error : new Error(String(error));
  captureException(sentryError, {
    tags: {
      error_category: category,
      error_context: context,
    },
    extra: fullLabels,
  });
}
