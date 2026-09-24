/**
 * Workflow Metrics Instrumentation
 *
 * Helper functions to instrument workflow execution with golden signal metrics.
 */

import { triggerTypeOf } from "@/lib/workflow/trigger-type";
import { createTimer, getMetricsCollector } from "../index";
import { LabelKeys, MetricNames, type TriggerType } from "../types";

/**
 * Error message prefixes that indicate a user-config failure (bad URL,
 * missing template variable, etc.) rather than a system fault. These
 * route through `recordWarning` so they don't fire system-error alerts.
 *
 * Match against the message's `HTTP request failed: ` step wrapper too,
 * since that's how http-request.ts surfaces safeFetch throws.
 */
const USER_CONFIG_ERROR_PATTERNS: readonly RegExp[] = [
  /safe-fetch: invalid URL/i,
  /safe-fetch: scheme .* not allowed/i,
  /blocked by SSRF policy/i,
  /URL is required/i,
  /Missing template variable/i,
];

function isUserConfigError(message: string): boolean {
  return USER_CONFIG_ERROR_PATTERNS.some((p) => p.test(message));
}

/**
 * Record workflow execution start and return a timer function
 */
export function startWorkflowMetrics(options: {
  workflowId?: string;
  executionId?: string;
  triggerType?: TriggerType;
}): () => void {
  const metrics = getMetricsCollector();
  const timer = createTimer();

  const labels: Record<string, string> = {};
  if (options.workflowId) {
    labels[LabelKeys.WORKFLOW_ID] = options.workflowId;
  }
  if (options.executionId) {
    labels[LabelKeys.EXECUTION_ID] = options.executionId;
  }
  if (options.triggerType) {
    labels[LabelKeys.TRIGGER_TYPE] = options.triggerType;
  }

  // Increment execution counter
  metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_TOTAL, labels);

  // Return completion function
  return (success = true) => {
    metrics.recordLatency(MetricNames.WORKFLOW_EXECUTION_DURATION, timer(), {
      ...labels,
      [LabelKeys.STATUS]: success ? "success" : "failure",
    });
  };
}

/**
 * Record workflow execution completion
 */
export function recordWorkflowComplete(options: {
  workflowId?: string;
  executionId?: string;
  triggerType?: TriggerType;
  durationMs: number;
  success: boolean;
  error?: Error | string;
}): void {
  const metrics = getMetricsCollector();

  const labels: Record<string, string> = {
    [LabelKeys.STATUS]: options.success ? "success" : "failure",
  };
  if (options.workflowId) {
    labels[LabelKeys.WORKFLOW_ID] = options.workflowId;
  }
  if (options.executionId) {
    labels[LabelKeys.EXECUTION_ID] = options.executionId;
  }
  if (options.triggerType) {
    labels[LabelKeys.TRIGGER_TYPE] = options.triggerType;
  }

  // Record duration
  metrics.recordLatency(
    MetricNames.WORKFLOW_EXECUTION_DURATION,
    options.durationMs,
    labels
  );

  // Record error if failed
  if (!options.success && options.error) {
    const errorObj =
      typeof options.error === "string"
        ? { message: options.error }
        : options.error;

    if (isUserConfigError(errorObj.message)) {
      metrics.recordWarning(
        MetricNames.WORKFLOW_EXECUTION_ERRORS,
        errorObj,
        labels
      );
    } else {
      metrics.recordError(
        MetricNames.WORKFLOW_EXECUTION_ERRORS,
        errorObj,
        labels
      );
    }
  }
}

/**
 * Record step execution metrics
 */
export function recordStepMetrics(options: {
  executionId?: string;
  nodeId: string;
  nodeName: string;
  stepType: string;
  durationMs: number;
  success: boolean;
  error?: string;
  // Machine-readable failure code returned by the step (e.g. VALIDATION,
  // POLICY_BLOCKED, UPSTREAM). Used to distinguish a deliberate guard deny
  // from a transient failure in step-error metrics.
  code?: string;
}): void {
  const metrics = getMetricsCollector();

  const labels: Record<string, string> = {
    [LabelKeys.STEP_TYPE]: options.stepType,
    [LabelKeys.STATUS]: options.success ? "success" : "failure",
  };
  if (options.executionId) {
    labels[LabelKeys.EXECUTION_ID] = options.executionId;
  }

  // Record step duration
  metrics.recordLatency(
    MetricNames.WORKFLOW_STEP_DURATION,
    options.durationMs,
    labels
  );

  // Record error if failed
  if (!options.success && options.error) {
    const errorLabels: Record<string, string> = { ...labels };
    if (options.code) {
      // Keep a security/validation deny distinguishable from a transient
      // upstream failure in WORKFLOW_STEP_ERRORS dashboards and alerts.
      errorLabels[LabelKeys.ERROR_TYPE] = options.code;
    }
    metrics.recordError(
      MetricNames.WORKFLOW_STEP_ERRORS,
      { message: options.error },
      errorLabels
    );
  }
}

/**
 * Determine trigger type from workflow nodes
 */
export function detectTriggerType(
  nodes: Array<{ data: { type: string; config?: Record<string, unknown> } }>
): TriggerType {
  // A label has to be something, so an unrecognised trigger stays "manual"
  // here and the metric keeps the shape it has always had. Authorization does
  // not get the same courtesy: see triggerTypeOf.
  return triggerTypeOf(nodes) ?? "manual";
}
