import "server-only";

import { getMetricsCollector } from "@/lib/metrics";
import type { ExecutionResult } from "@/lib/workflow/executor/final-success";
import { getCompletedStepOutput } from "@/lib/workflow/executor/get-completed-step-output";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";

export type { ExecutionResult } from "@/lib/workflow/executor/final-success";

function isSpuriousError(message: string): boolean {
  return (
    EXCEEDED_MAX_RETRIES_REGEX.test(message) ||
    FAILED_AFTER_RETRIES_REGEX.test(message) ||
    NO_STEP_COMPLETION_REGEX.test(message)
  );
}

/**
 * Post-drain reconciliation pass for KEEP-398.
 *
 * Iterates over all results entries whose error matches the spurious max-retries
 * pattern. For each candidate, queries the step-success-tracker first (fast
 * path) and then `workflow_execution_logs` (cross-process fallback). When a
 * success record exists, overrides the failed result entry in-place and
 * increments the `workflow.executor.spurious_recovery.total` counter with
 * source="post_drain".
 *
 * Error containment is delegated to getCompletedStepOutput: DB rejections are
 * caught inside the helper, which evicts the cache, logs a structured warning,
 * increments tracker_db_fallback.total{outcome=error}, and returns null. A null
 * return here skips the candidate and continues to the next. A single transient
 * DB failure cannot abort the whole pass.
 *
 * Mutates `results` in-place (same contract as the rest of the executor).
 */
export async function reconcileSpuriousFailures(params: {
  executionId: string | undefined;
  results: Record<string, ExecutionResult>;
  workflowId?: string;
  organizationId?: string;
  organizationPlan?: string;
}): Promise<void> {
  const { executionId, results, workflowId, organizationId, organizationPlan } =
    params;

  if (!executionId) {
    return;
  }

  const metricsLabels: Record<string, string> = {
    source: "post_drain",
  };
  if (workflowId) {
    metricsLabels.workflow_id = workflowId;
  }
  if (organizationId) {
    metricsLabels.org_id = organizationId;
  }
  if (organizationPlan) {
    metricsLabels.plan = organizationPlan;
  }

  for (const [nodeId, result] of Object.entries(results)) {
    if (result.success) {
      continue;
    }

    const errorMessage = result.error ?? "";
    if (!isSpuriousError(errorMessage)) {
      continue;
    }

    const completed = await getCompletedStepOutput(executionId, nodeId);
    if (completed === null) {
      continue;
    }

    result.success = true;
    result.data = completed.output;
    result.error = undefined;

    getMetricsCollector().incrementCounter(
      "workflow.executor.spurious_recovery.total",
      metricsLabels
    );
  }
}
