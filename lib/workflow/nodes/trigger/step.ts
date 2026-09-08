/**
 * Trigger step - handles trigger execution with proper logging
 * Also handles workflow completion when called with _workflowComplete
 * KEEP-468: also handles per-node failure logging via _recordStepFailure
 * for errors raised inside the workflow body (e.g. TemplateResolutionError)
 * before executeActionStep ever runs. Routes the DB write through this
 * step's "use step" boundary because the workflow body forbids Node.js
 * modules (the postgres driver, nanoid, etc.).
 */
import "server-only";

import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  logStepCompleteDb,
  logStepStartDb,
  updateForEachLogToError,
} from "@/lib/workflow/executor/logging";
import {
  logWorkflowComplete,
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

type TriggerResult = {
  success: true;
  data: Record<string, unknown>;
  /** See TriggerInput.triggerGasUsed. Omitted when there is nothing to report. */
  triggerGasUsed?: string;
};

export type TriggerInput = StepInput & {
  triggerData: Record<string, unknown>;
  /**
   * The chain the trigger node is configured against, when it has one. Logged
   * rather than executed: it is what puts an on-chain trigger's network into
   * the run's `workflow_execution_logs` row, which is where /analytics reads
   * the Network column from.
   */
  network?: string;
  /**
   * Native cost, in wei, of the transaction that fired an on-chain trigger.
   * Reported under its own key rather than `gasUsed` on purpose: that key is
   * what every gas rollup sums, and this transaction was sent by whoever
   * emitted the event, not by the keeper. See lib/workflow/nodes/trigger-gas.
   */
  triggerGasUsed?: string;
  /** If set, this call is just to log workflow completion (no trigger execution) */
  _workflowComplete?: {
    executionId: string;
    status: "success" | "error";
    output?: unknown;
    error?: string;
    /** Authoritative error type from the failing step; overrides the classifier. */
    errorClass?: ExecutionErrorType;
    startTime: number;
  };
  /**
   * KEEP-468: If set, write a workflow_execution_logs row for a node that
   * failed before its step could run (e.g. TemplateResolutionError raised
   * inside processActionConfig). No trigger execution occurs.
   */
  _recordStepFailure?: {
    executionId: string;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    error: string;
  };
  /**
   * KEEP-894: If set, flip the For Each node's own log row to error status
   * so the run UI shows which step errored rather than all green. Routes the
   * DB write through this step's boundary because the workflow body forbids
   * Node.js modules.
   */
  _recordForEachError?: {
    executionId: string;
    nodeId: string;
    error: string;
  };
};

/**
 * Trigger logic - just passes through the trigger data
 */
function executeTrigger(input: TriggerInput): TriggerResult {
  return {
    success: true,
    data: input.triggerData,
    ...(input.triggerGasUsed ? { triggerGasUsed: input.triggerGasUsed } : {}),
  };
}

/**
 * Persist a single workflow_execution_logs row marked failed for a node
 * that aborted before its step ran. Mirrors the start+complete pair
 * withStepLogging would have written.
 */
async function recordStepFailure(
  failure: NonNullable<TriggerInput["_recordStepFailure"]>
): Promise<void> {
  const start = await logStepStartDb({
    executionId: failure.executionId,
    nodeId: failure.nodeId,
    nodeName: failure.nodeName,
    nodeType: failure.nodeType,
    input: undefined,
  });
  if (!start.logId) {
    return;
  }
  await logStepCompleteDb({
    logId: start.logId,
    startTime: start.startTime,
    status: "error",
    error: failure.error,
    executionId: failure.executionId,
  });
}

/**
 * Trigger Step
 * Executes a trigger and logs it properly
 * Also handles workflow completion when called with _workflowComplete
 * Also handles per-node failure logging when called with _recordStepFailure
 */
export async function triggerStep(input: TriggerInput): Promise<TriggerResult> {
  "use step";

  // If this is a completion-only call, just log workflow completion
  if (input._workflowComplete) {
    await logWorkflowComplete(input._workflowComplete);
    return { success: true, data: {} };
  }

  // KEEP-468: per-node failure log for pre-step aborts (e.g. template resolution)
  if (input._recordStepFailure) {
    await recordStepFailure(input._recordStepFailure);
    return { success: true, data: {} };
  }

  // KEEP-894: flip For Each node's log row to error when iterations fail
  if (input._recordForEachError) {
    await updateForEachLogToError(input._recordForEachError);
    return { success: true, data: {} };
  }

  // Normal trigger execution with logging
  return withStepLogging(input, () => Promise.resolve(executeTrigger(input)));
}
triggerStep.maxRetries = 0;
