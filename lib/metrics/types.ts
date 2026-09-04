/**
 * Golden Signal Metrics Types
 *
 * Application-level metrics for workflow execution, user activity, and plugin operations.
 * Follows the four golden signals: Latency, Traffic, Errors, Saturation.
 */

/**
 * Metric types supported by the collector
 */
export type MetricType = "counter" | "histogram" | "gauge";

/**
 * Labels for metric dimensions - keep minimal to avoid cardinality explosion
 */
export type MetricLabels = Record<string, string | number | boolean>;

/**
 * Structured metric event for logging
 */
export type MetricEvent = {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  metric: {
    name: string;
    type: MetricType;
    value: number;
    labels?: MetricLabels;
  };
};

/**
 * Error context for error metrics
 */
export type ErrorContext = {
  code?: string;
  message: string;
  stack?: string;
  cause?: string;
};

/**
 * Core metrics collector interface
 *
 * Allows dependency injection for different environments:
 * - Console collector for server-side (CloudWatch/Datadog compatible)
 * - Noop collector for frontend/testing
 */
export type MetricsCollector = {
  /**
   * Record a latency/duration measurement (histogram)
   * @param name - Metric name (e.g., "workflow.execution.duration_ms")
   * @param durationMs - Duration in milliseconds
   * @param labels - Optional labels for dimensions
   */
  recordLatency(name: string, durationMs: number, labels?: MetricLabels): void;

  /**
   * Increment a counter metric
   * @param name - Metric name (e.g., "workflow.executions.total")
   * @param labels - Optional labels for dimensions
   * @param value - Increment value (default: 1)
   */
  incrementCounter(name: string, labels?: MetricLabels, value?: number): void;

  /**
   * Record an error with context
   * @param name - Metric name (e.g., "workflow.execution.errors")
   * @param error - Error object or context
   * @param labels - Optional labels for dimensions
   */
  recordError(
    name: string,
    error: Error | ErrorContext,
    labels?: MetricLabels
  ): void;

  /**
   * Record a user-caused failure as a warning (does not page on-call).
   * Same shape as recordError but logged at warn level.
   * @param name - Metric name (e.g., "workflow.execution.errors")
   * @param error - Error object or context
   * @param labels - Optional labels for dimensions
   */
  recordWarning(
    name: string,
    error: Error | ErrorContext,
    labels?: MetricLabels
  ): void;

  /**
   * Set a gauge metric (point-in-time value)
   * @param name - Metric name (e.g., "workflow.concurrent.count")
   * @param value - Current value
   * @param labels - Optional labels for dimensions
   */
  setGauge(name: string, value: number, labels?: MetricLabels): void;
};

/**
 * Predefined metric names for consistency
 */
export const MetricNames = {
  // Latency metrics
  WORKFLOW_EXECUTION_DURATION: "workflow.execution.duration_ms",
  WORKFLOW_STEP_DURATION: "workflow.step.duration_ms",
  API_WEBHOOK_LATENCY: "api.webhook.latency_ms",
  API_STATUS_LATENCY: "api.status.latency_ms",
  PLUGIN_ACTION_DURATION: "plugin.action.duration_ms",
  AI_GENERATION_DURATION: "ai.generation.duration_ms",

  // Traffic metrics
  WORKFLOW_EXECUTIONS_TOTAL: "workflow.executions.total",
  WORKFLOW_EXECUTIONS_STARTED_TOTAL: "workflow.executions.started.total",
  WORKFLOW_EXPORTS_TOTAL: "workflow.exports.total",
  WORKFLOW_IMPORTS_TOTAL: "workflow.imports.total",
  PLUGIN_INVOCATIONS_TOTAL: "plugin.invocations.total",
  USER_ACTIVE_DAILY: "user.active.daily",

  // Error metrics
  WORKFLOW_EXECUTION_ERRORS: "workflow.execution.errors",
  WORKFLOW_STEP_ERRORS: "workflow.step.errors",
  PLUGIN_ACTION_ERRORS: "plugin.action.errors",
  API_ERRORS_TOTAL: "api.errors.total",

  // User-caused error metrics
  USER_VALIDATION_ERRORS: "errors.user.validation.total",
  USER_CONFIGURATION_ERRORS: "errors.user.configuration.total",
  USER_AUTHORIZATION_ERRORS: "errors.user.authorization.total",
  EXTERNAL_SERVICE_ERRORS: "errors.external.service.total",
  NETWORK_RPC_ERRORS: "errors.network.rpc.total",
  TRANSACTION_BLOCKCHAIN_ERRORS: "errors.transaction.blockchain.total",

  // System-caused error metrics
  SYSTEM_DATABASE_ERRORS: "errors.system.database.total",
  SYSTEM_AUTH_ERRORS: "errors.system.auth.total",
  SYSTEM_INFRASTRUCTURE_ERRORS: "errors.system.infrastructure.total",
  SYSTEM_WORKFLOW_ENGINE_ERRORS: "errors.system.workflow_engine.total",
  // A dropped security audit row is itself security-relevant: make silent loss
  // observable so the best-effort path can be alerted on.
  SECURITY_AUDIT_WRITE_FAILED: "errors.system.security_audit_write.total",
  // The per-organization MCP limiter serves a decision from its per-pod
  // fallback whenever the shared Redis window is unreachable, which silently
  // multiplies the fleet-wide ceiling by the replica count. A throttled log
  // line cannot answer "is the shared limiter enforcing right now"; this
  // counter can.
  MCP_RATE_LIMIT_DEGRADED: "ratelimit.mcp.degraded.total",

  // Sponsorship metrics
  SPONSORSHIP_TRANSACTIONS_TOTAL: "sponsorship.transactions.total",
  SPONSORSHIP_GAS_USED_TOTAL: "sponsorship.gas_used.total",
  SPONSORSHIP_GAS_COST_USD_MICRO_TOTAL: "sponsorship.gas_cost_usd_micro.total",

  // Billing lifecycle counters (API-process, emitted from webhook handler)
  BILLING_SUBSCRIPTION_CREATED: "billing.subscription.created",
  BILLING_TRIAL_STARTED: "billing.trial.started",
  BILLING_TRIAL_CONVERTED: "billing.trial.converted",
  BILLING_SUBSCRIPTION_UPDATED: "billing.subscription.updated",
  BILLING_SUBSCRIPTION_CANCELED: "billing.subscription.canceled",
  BILLING_SUBSCRIPTION_PLAN_CHANGED: "billing.subscription.plan_changed",
  BILLING_INVOICE_PAID: "billing.invoice.paid",
  BILLING_INVOICE_FAILED: "billing.invoice.failed",
  BILLING_OVERAGE_CHARGED: "billing.overage.charged",

  // Saturation metrics
  DB_POOL_UTILIZATION: "db.pool.utilization",
  DB_QUERY_SLOW_COUNT: "db.query.slow_count",
  WORKFLOW_QUEUE_DEPTH: "workflow.queue.depth",
  WORKFLOW_CONCURRENT_COUNT: "workflow.concurrent.count",

  // Safe wallet metrics (KEEP-301 wave 2). Cover the hot paths only:
  //  - safe.deploy.*           CREATE2 deploy through the SafeProxyFactory
  //  - safe.role_install.*     Roles modifier proxy deploy + initial config
  //  - safe.tx.*               safe.execTransaction (owner-signed) and
  //                            rolesModifier.execTransactionWithRole writes
  //  - safe.withdraw.*         User-initiated withdrawals routed through
  //                            executeContractCallAsSafe / executeNativeTransferAsSafe
  SAFE_DEPLOY_DURATION: "safe.deploy.duration_ms",
  SAFE_DEPLOY_TOTAL: "safe.deploy.total",
  SAFE_ROLE_INSTALL_DURATION: "safe.role_install.duration_ms",
  SAFE_ROLE_INSTALL_TOTAL: "safe.role_install.total",
  SAFE_TX_DURATION: "safe.tx.duration_ms",
  SAFE_TX_TOTAL: "safe.tx.total",
  SAFE_WITHDRAW_TOTAL: "safe.withdraw.total",

  // Signer-mode resolver distribution counter (KEEP-568). Emitted once per
  // `resolveSignerMode` call, labelled by kind so dashboards can answer
  // "what fraction of org writes are policy-gated (`safe-role`) vs
  // unscoped (`safe`) vs EOA (`eoa`)?" -- the per-tx safe.tx.total
  // counter only covers the two Safe branches.
  SIGNER_MODE_TOTAL: "signer_mode.total",

  // Probe-swallow counter (KEEP-567). Fires when the Safe role-modifier
  // chain probe fails (both primary + fallback RPC) and the resolver
  // silently downgrades to unscoped `safe` mode. Needed to measure how
  // often the policy-bypass window opens before deciding whether to
  // hard-fail the resolver vs keep the current silent-downgrade behavior.
  SIGNER_PROBE_FAILURE: "signer_probe.failure.total",

  // Scan observability metrics (HARDEN-03)
  SCAN_ADDRESS_DURATION: "scan.address.duration_ms",
  SCAN_CACHE_HIT_TOTAL: "scan.cache.hit.total",
  SCAN_CACHE_MISS_TOTAL: "scan.cache.miss.total",
  SCAN_ZERION_CALLS_TOTAL: "scan.zerion.calls.total",

  // SQS trigger-message authentication. One counter labelled by
  // auth_result (valid | unsigned | unknown_caller | bad_signature |
  // invalid_schema | stale) and mode (warn | enforce). Drives the rollout gate:
  // flip the executor to enforce only once unsigned/invalid series hit zero.
  SQS_MESSAGE_AUTH: "sqs.message.auth.total",

  // SQS consume-path idempotency claim outcome. One increment per consumed
  // trigger, labelled by claim_result and trigger_type:
  //  - claimed:          dispatched (incl. re-claim of a reaped-never-ran row).
  //  - dropped_advanced: a duplicate whose row already ran/advanced - dropped
  //                      (this is a prevented double-execution).
  //  - dropped_missing:  the row was gone (discarded/retention) - dropped.
  //  - idless_insert:    legacy id-less message, insert-fresh + run (cannot be
  //                      deduped; a rise signals upstream phantom-create failures).
  SQS_CONSUME_CLAIM: "sqs.consume.claim.total",
} as const;

/**
 * Common label keys for consistency
 */
export const LabelKeys = {
  WORKFLOW_ID: "workflow_id",
  EXECUTION_ID: "execution_id",
  ORG_ID: "org_id",
  ORG_SLUG: "org_slug",
  ORG_NAME: "org_name",
  PLAN: "plan",
  OWNER_ID: "owner_id",
  PLUGIN_ID: "plugin_id",
  INTEGRATION_ID: "integration_id",
  STEP_TYPE: "step_type",
  PLUGIN_NAME: "plugin_name",
  ACTION_NAME: "action_name",
  TRIGGER_TYPE: "trigger_type",
  STATUS: "status",
  STATUS_CODE: "status_code",
  ERROR_TYPE: "error_type",
  ENDPOINT: "endpoint",
  SERVICE: "service",
  ERROR_CATEGORY: "error_category",
  ERROR_CONTEXT: "error_context",
  BILLING_STATUS: "billing_status",
  TIER: "tier",
  AUTH_RESULT: "auth_result",
  MODE: "mode",
  CLAIM_RESULT: "claim_result",
} as const;

/**
 * Trigger types for workflow executions.
 *
 * "scheduled" is the legacy label used for any internal call before the per-source
 * discriminator was introduced. New code should prefer the precise values
 * "schedule" (cron-based), "block" (block-interval), or "event" (smart contract
 * event). Both "scheduled" and "schedule" are kept here so historical metric
 * series remain valid.
 */
export type TriggerType =
  | "manual"
  | "webhook"
  | "scheduled"
  | "schedule"
  | "block"
  | "event"
  | "transfer";

const TRIGGER_TYPES: ReadonlySet<TriggerType> = new Set<TriggerType>([
  "manual",
  "webhook",
  "scheduled",
  "schedule",
  "block",
  "event",
  "transfer",
]);

export function isTriggerType(value: unknown): value is TriggerType {
  return typeof value === "string" && TRIGGER_TYPES.has(value as TriggerType);
}

/**
 * Execution status values
 */
export type ExecutionStatus = "success" | "failure" | "timeout" | "cancelled";

/**
 * Subscription billing status values reported as the `billing_status` label.
 * Mirrors organization_subscriptions.status, plus "none" for orgs that have
 * no subscription row (legacy / pre-billing).
 */
export type BillingStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"
  | "none";
