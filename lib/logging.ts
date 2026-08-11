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
 * - Includes standard labels (error_category, error_context, error_type)
 *
 * @example
 * logUserError(ErrorCategory.VALIDATION, "[Check Balance] Invalid address:", address, { plugin_name: "web3" });
 * logUserError(ErrorCategory.EXTERNAL_SERVICE, "[Etherscan] API failed:", error, { service: "etherscan" });
 * logSystemError(ErrorCategory.DATABASE, "[DB] Insert failed:", error, { table: "workflows" });
 * logSystemError(ErrorCategory.INFRASTRUCTURE, "[Para] API key missing:", error, { component: "para-service" });
 */

import { captureException, captureMessage } from "@sentry/nextjs";
import { emitLogLine, type LogLevel, type LogPayload } from "@/lib/log/core";
import { getMetricsCollector } from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import { scrubRpcUrls } from "@/lib/rpc/scrub-rpc-urls";
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
  // KEEP-344: wallet addresses are unbounded across users; never sent to
  // Prometheus. KEEP-814: also scrubbed from Sentry extras (see SENTRY_PII_LABELS).
  // They remain in the structured console line for incident debugging.
  "wallet_address",
]);

/**
 * Labels scrubbed from Sentry `extra` payloads (PII / sensitive). They are kept
 * in the structured console line (captured by Loki, access-controlled) but not
 * shipped to Sentry, which has a broader audience and longer retention.
 */
const SENTRY_PII_LABELS = new Set<string>(["wallet_address", "email"]);

function scrubSentryExtra(
  labels: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!SENTRY_PII_LABELS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

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
      message: scrubRpcUrls(error.message),
      name: error.name,
      stack: error.stack === undefined ? undefined : scrubRpcUrls(error.stack),
    };
  }
  if (error === undefined || error === null || error === "") {
    return;
  }
  return { message: scrubRpcUrls(String(error)) };
}

/**
 * KEEP-545: serialize an error/log event as a single-line JSON object so
 * Grafana Cloud Loki can extract top-level keys via `| json`. Drilldown
 * from the managed-client SLI alert to the failing execution requires
 * `execution_id`, `error_type`, and `error_category` to be available as
 * Loki labels, not just as text inside the message string.
 *
 * The human-readable `msg` field retains the original message and the
 * `[org:Sky][exec:xyz]` tag so `kubectl logs` greps still work.
 */
function buildStructuredPayload(args: {
  message: string;
  tag: string;
  fullLabels: Record<string, string>;
  category: ErrorCategory;
  context: string;
  errorType: "user" | "system" | undefined;
  error: unknown;
}): LogPayload {
  const errPayload = buildErrPayload(args.error);

  const payload: LogPayload = {
    msg: `${args.message}${args.tag}`,
    error_category: args.category,
    error_context: args.context,
  };
  if (args.errorType !== undefined) {
    payload.error_type = args.errorType;
  }
  for (const [k, v] of Object.entries(args.fullLabels)) {
    if (v !== undefined && !(k in payload)) {
      payload[k] = v;
    }
  }
  if (errPayload) {
    payload.err = errPayload;
  }
  return payload;
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
  BILLING: "billing",

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

  // KEEP-545: emit structured JSON so Loki indexes error_type,
  // error_category, execution_id, org_slug as queryable labels via `| json`.
  // User errors are logged at warn level so they don't page on-call.
  const tag = buildLogTag(fullLabels);
  emitLogLine(
    "warn",
    buildStructuredPayload({
      message,
      tag,
      fullLabels,
      category,
      context,
      errorType: "user",
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
      [LabelKeys.ERROR_TYPE]: "user",
    }
  );

  // User errors are tracked via the Prometheus metric above and the structured
  // console line; they are intentionally NOT sent to Sentry. They are expected
  // and high-volume (invalid addresses, validation failures, external-API
  // hiccups) and would drown actionable system errors and burn Sentry quota.
  // Alert on the user-error metric rates in Grafana instead.
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

  // KEEP-545: emit structured JSON so Loki indexes error_type,
  // error_category, execution_id, org_slug as queryable labels via `| json`.
  const tag = buildLogTag(fullLabels);
  emitLogLine(
    "error",
    buildStructuredPayload({
      message,
      tag,
      fullLabels,
      category,
      context,
      errorType: "system",
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
      [LabelKeys.ERROR_TYPE]: "system",
    }
  );

  // Report to Sentry for alerting
  const sentryError = error instanceof Error ? error : new Error(String(error));
  captureException(sentryError, {
    tags: {
      error_category: category,
      error_context: context,
    },
    extra: scrubSentryExtra(fullLabels),
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
 *   - error_type is intentionally NOT set. At the call sites where this
 *     helper fires we typically do not yet know whether the underlying
 *     failure is user-caused or engine-caused -- forcing the tag to "system"
 *     would let alerts filtering `error_type:system` match these events
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
  // and error_category for the warn-level recovery/notice events. error_type
  // is intentionally omitted on logSystemWarn (the call site does not yet
  // know whether the underlying failure is user-caused or engine-caused);
  // alerts that filter `error_type="system"` therefore won't re-trip on
  // these events. See logSystemWarn jsdoc for full reasoning.
  const tag = buildLogTag(fullLabels);
  emitLogLine(
    "warn",
    buildStructuredPayload({
      message,
      tag,
      fullLabels,
      category,
      context,
      errorType: undefined,
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
    extra: scrubSentryExtra(fullLabels),
  });
}

/**
 * Audit-log every internal-service auth attempt. Emits a single-line JSON
 * record (event="internal_service_auth") so Grafana Loki can alert on a
 * reject-rate spike via `| json | event="internal_service_auth" | outcome="reject"`.
 *
 * Logs-only for v1 -- there is no DB-backed audit table yet. If Loki
 * retention proves insufficient during an incident, add a parallel insert
 * into a new internal_service_auth_audit table.
 *
 * No Sentry call: accepts would page on every internal request, and rejects
 * are better caught by a Grafana threshold alert than by per-event Sentry
 * captures (one bad client can DDoS the Sentry quota in minutes).
 */
export function logInternalAuthEvent(fields: {
  outcome: "accept" | "reject";
  scheme: "hmac" | "none";
  caller: string;
  route: string;
  method: string;
  ip: string | null;
  keyVersion?: number;
  reason?: string;
  latencyMs?: number;
}): void {
  const payload: LogPayload = {
    msg: `[InternalAuth] ${fields.outcome} caller=${fields.caller} scheme=${fields.scheme} route=${fields.route}`,
    event: "internal_service_auth",
    outcome: fields.outcome,
    scheme: fields.scheme,
    caller: fields.caller,
    route: fields.route,
    method: fields.method,
  };
  if (fields.ip !== null) {
    payload.ip = fields.ip;
  }
  if (fields.keyVersion !== undefined) {
    payload.key_version = fields.keyVersion;
  }
  if (fields.reason !== undefined) {
    payload.reason = fields.reason;
  }
  if (fields.latencyMs !== undefined) {
    payload.latency_ms = fields.latencyMs;
  }
  // Structured audit-log sink intended to land in Grafana Loki via stdout
  // capture; no Sentry capture by design (accepts would page on every
  // internal request; rejects are better caught by a Grafana threshold).
  emitLogLine("info", payload);
}

/**
 * Structured non-error logging helpers.
 *
 * Emit a single canonical JSON line (no Prometheus metric, no Sentry) for
 * informational, lifecycle, and developer-debug logs. They merge the
 * async-local workflow context (org/owner/workflow/execution ids) and append
 * the human-readable `[org:..][exec:..]` tag, so breadcrumbs correlate with
 * the error lines emitted by logUserError/logSystemError.
 *
 * Use logInfo for lifecycle/state-transition notes, logDebug for verbose
 * troubleshooting traces (gated by LOG_LEVEL=debug), and logWarn for benign
 * fallbacks that are not operational failures and do not warrant a metric.
 */
function logAtLevel(
  level: LogLevel,
  message: string,
  labels?: Record<string, string>
): void {
  const fullLabels = mergeLabels(labels);
  const tag = buildLogTag(fullLabels);
  const payload: LogPayload = { msg: `${message}${tag}` };
  for (const [k, v] of Object.entries(fullLabels)) {
    if (v !== undefined && !(k in payload)) {
      payload[k] = v;
    }
  }
  emitLogLine(level, payload);
}

export function logDebug(
  message: string,
  labels?: Record<string, string>
): void {
  logAtLevel("debug", message, labels);
}

export function logInfo(
  message: string,
  labels?: Record<string, string>
): void {
  logAtLevel("info", message, labels);
}

export function logWarn(
  message: string,
  labels?: Record<string, string>
): void {
  logAtLevel("warn", message, labels);
}

/**
 * Emit a KEEP-612 `security.*` detection signal: a Sentry event (for triage
 * pivots) plus a canonical structured stdout line (for the Loki line-filter
 * alerts in keeperhub-security-alerts.tf). Both transports are best-effort and
 * self-guarded so a transport failure never escapes into the caller - these
 * fire from auth hooks and the executor hot path, where a throw would change
 * request/execution semantics.
 *
 * `name` is the event suffix without the `security.` prefix (e.g.
 * "backstop_session_blocked"); the literal `security.<name>` string is what
 * the Loki alerts match, so it must stay verbatim in the emitted line.
 *
 * Sentry capture is skipped entirely when `sentry` is omitted (some signals -
 * e.g. content_scanner_error - are log-only by design).
 */
export function logSecurityEvent(
  name: string,
  fields?: Record<string, unknown>,
  sentry?: {
    level?: "warning" | "error";
    tags?: Record<string, string>;
    user?: { id?: string };
    extra?: Record<string, unknown>;
    fingerprint?: string[];
  }
): void {
  const event = `security.${name}`;

  if (sentry) {
    try {
      captureMessage(event, {
        level: sentry.level ?? "warning",
        ...(sentry.tags ? { tags: sentry.tags } : {}),
        ...(sentry.user ? { user: sentry.user } : {}),
        ...(sentry.extra ? { extra: sentry.extra } : {}),
        ...(sentry.fingerprint ? { fingerprint: sentry.fingerprint } : {}),
      });
    } catch {
      // observability must never escape into the caller
    }
  }

  try {
    const level: LogLevel = sentry?.level === "error" ? "error" : "warn";
    emitLogLine(level, { msg: `[Security] ${name}`, event, ...fields });
  } catch {
    // emission must never escape into the caller
  }
}
