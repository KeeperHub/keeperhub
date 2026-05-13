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
import { getWorkflowErrorContext } from "@/lib/workflow/executor/error-context";

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
  // KEEP-344: wallet addresses are unbounded across users. Console and Sentry
  // still see this label; Prometheus does not.
  "wallet_address",
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

function buildErrPayload(
  error: unknown
): { message: string; name?: string; stack?: string } | undefined {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  if (error === undefined || error === null || error === "") {
    return;
  }
  return { message: String(error) };
}

/**
 * KEEP-545: serialize an error/log event as a single-line JSON object so
 * Grafana Cloud Loki can extract top-level keys via `| json`. Drilldown
 * from the managed-client SLA alert to the failing execution requires
 * `execution_id`, `is_user_error`, and `error_category` to be available as
 * Loki labels, not just as text inside the message string.
 *
 * The human-readable `msg` field retains the original message and the
 * `[org:Sky][exec:xyz]` tag so `kubectl logs` greps still work.
 */
function serializeStructuredLogLine(args: {
  level: "warn" | "error";
  message: string;
  tag: string;
  fullLabels: Record<string, string>;
  category: ErrorCategory;
  context: string;
  isUserError: "true" | "false" | undefined;
  error: unknown;
}): string {
  const errPayload = buildErrPayload(args.error);

  const payload: Record<string, unknown> = {
    level: args.level,
    msg: `${args.message}${args.tag}`,
    error_category: args.category,
    error_context: args.context,
  };
  if (args.isUserError !== undefined) {
    payload.is_user_error = args.isUserError;
  }
  for (const [k, v] of Object.entries(args.fullLabels)) {
    if (v !== undefined && !(k in payload)) {
      payload[k] = v;
    }
  }
  if (errPayload) {
    payload.err = errPayload;
  }
  return JSON.stringify(payload);
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

  // KEEP-545: emit structured JSON so Loki indexes is_user_error,
  // error_category, execution_id, org_slug as queryable labels via `| json`.
  // User errors are logged at warn level so they don't page on-call.
  const tag = buildLogTag(fullLabels);
  console.warn(
    serializeStructuredLogLine({
      level: "warn",
      message,
      tag,
      fullLabels,
      category,
      context,
      isUserError: "true",
      error,
    })
  );

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

  // KEEP-545: emit structured JSON so Loki indexes is_user_error,
  // error_category, execution_id, org_slug as queryable labels via `| json`.
  const tag = buildLogTag(fullLabels);
  console.error(
    serializeStructuredLogLine({
      level: "error",
      message,
      tag,
      fullLabels,
      category,
      context,
      isUserError: "false",
      error,
    })
  );

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

/**
 * Log a system-level warning. Emits a Sentry event at warning level and a
 * console.warn line. Does NOT emit a Prometheus metric and does NOT page.
 *
 * Use for events in system-owned code that need ALS context (org/owner ids)
 * for later investigation but are NOT operational failures. Examples:
 * - Pre-reconciliation notes where the final classification is not yet known
 * - Recovery events (spurious SDK error overridden back to success)
 * - Expected fallbacks worth recording for debugging
 *
 * Side effects (compare to siblings):
 *
 * |                        | console     | Sentry          | Metric    |
 * | ---------------------- | ----------- | --------------- | --------- |
 * | logSystemError         | error       | error event     | counter+1 |
 * | logSystemWarn (this)   | warn        | warning event   | none      |
 * | logUserError           | warn        | warning event   | counter+1 |
 *
 * Sentry tag policy:
 *   - is_user_error is intentionally NOT set. At the call sites where this
 *     helper fires we typically do not yet know whether the underlying
 *     failure is user-caused or engine-caused -- forcing the tag to "false"
 *     would let alerts filtering `is_user_error:false` match these events
 *     and re-trip the same dashboards we are trying to keep quiet. The
 *     event's `level=warning` is the canonical filter.
 */
export function logSystemWarn(
  category: ErrorCategory,
  message: string,
  error: unknown,
  labels?: Record<string, string>
): void {
  const context = extractContext(message);
  const fullLabels = mergeLabels(labels);

  // KEEP-545: emit structured JSON so Loki indexes execution_id, org_slug,
  // and error_category for the warn-level recovery/notice events. is_user_error
  // is intentionally omitted on logSystemWarn (the call site does not yet
  // know whether the underlying failure is user-caused or engine-caused);
  // alerts that filter `is_user_error="false"` therefore won't re-trip on
  // these events. See logSystemWarn jsdoc for full reasoning.
  const tag = buildLogTag(fullLabels);
  console.warn(
    serializeStructuredLogLine({
      level: "warn",
      message,
      tag,
      fullLabels,
      category,
      context,
      isUserError: undefined,
      error,
    })
  );

  const sentryError = error instanceof Error ? error : new Error(String(error));
  captureException(sentryError, {
    level: "warning",
    tags: {
      error_category: category,
      error_context: context,
    },
    extra: fullLabels,
  });
}
