/**
 * Step Handler - Logging utilities for workflow builder UI
 * These functions are called FROM INSIDE steps (within "use step" context)
 * Uses direct database calls for security (no HTTP endpoint)
 */
import "server-only";

import { ErrorCategory, logSystemError } from "@/lib/logging";
import { recordStepMetrics } from "@/lib/metrics/instrumentation/workflow";
import { recordStepSuccess } from "@/lib/step-success-tracker";
import {
  runWithWorkflowErrorContext,
  type WorkflowErrorContext,
} from "@/lib/workflow-error-context";
import { redactSensitiveData } from "../utils/redact";
import {
  incrementCompletedSteps,
  logStepCompleteDb,
  logStepStartDb,
  logWorkflowCompleteDb,
  updateCurrentStep,
} from "../workflow-logging";

export type StepContext = {
  executionId?: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  triggerType?: string;
  iterationIndex?: number;
  forEachNodeId?: string;
  organizationId?: string;
  // Identifiers attached to every workflow error log line
  orgSlug?: string;
  ownerId?: string;
  workflowId?: string;
};

/**
 * Build the async-local error context for a step. plugin_id is
 * derived from nodeType: plugin actions use "<plugin>/<action>" form, system
 * actions are bare names like "Condition" or "Database Query".
 */
function errorContextFromStep(
  ctx: StepContext,
  integrationId?: unknown
): WorkflowErrorContext {
  const slashIdx = ctx.nodeType.indexOf("/");
  const pluginId = slashIdx > 0 ? ctx.nodeType.slice(0, slashIdx) : undefined;
  return {
    workflow_id: ctx.workflowId,
    execution_id: ctx.executionId,
    org_id: ctx.organizationId,
    org_slug: ctx.orgSlug,
    owner_id: ctx.ownerId,
    plugin_id: pluginId,
    integration_id:
      typeof integrationId === "string" ? integrationId : undefined,
  };
}

/**
 * Base input type that all steps should extend
 * Adds optional _context for logging
 */
export type StepInput = {
  _context?: StepContext;
};

type LogInfo = {
  logId: string;
  startTime: number;
};

/**
 * Log the start of a step execution
 */
async function logStepStart(
  context: StepContext | undefined,
  input: unknown
): Promise<LogInfo> {
  if (!context?.executionId) {
    return { logId: "", startTime: Date.now() };
  }

  try {
    const redactedInput = redactSensitiveData(input);

    const result = await logStepStartDb({
      executionId: context.executionId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      nodeType: context.nodeType,
      input: redactedInput,
      iterationIndex: context.iterationIndex,
      forEachNodeId: context.forEachNodeId,
    });

    return result;
  } catch (error) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[stepHandler] Failed to log start",
      error
    );
    return { logId: "", startTime: Date.now() };
  }
}

/**
 * Log the completion of a step execution
 */
async function logStepComplete(
  logInfo: LogInfo,
  status: "success" | "error",
  output?: unknown,
  error?: string,
  executionId?: string
): Promise<void> {
  if (!logInfo.logId) {
    return;
  }

  try {
    const redactedOutput = redactSensitiveData(output);

    await logStepCompleteDb({
      logId: logInfo.logId,
      startTime: logInfo.startTime,
      status,
      output: redactedOutput,
      error,
      executionId,
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[stepHandler] Failed to log completion",
      err
    );
  }
}

/**
 * Strip _context from input for logging (we don't want to log internal metadata)
 */
function stripContext<T extends StepInput>(input: T): Omit<T, "_context"> {
  const { _context, ...rest } = input;
  return rest as Omit<T, "_context">;
}

/**
 * Log workflow execution completion
 * Call this from within a step context to update the overall workflow status
 */
export async function logWorkflowComplete(options: {
  executionId: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
  startTime: number;
}): Promise<void> {
  try {
    const redactedOutput = redactSensitiveData(options.output);

    await logWorkflowCompleteDb({
      executionId: options.executionId,
      status: options.status,
      output: redactedOutput,
      error: options.error,
      startTime: options.startTime,
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[stepHandler] Failed to log workflow completion",
      err
    );
  }
}

/**
 * Extended context that includes workflow completion info
 */
export type StepContextWithWorkflow = StepContext & {
  _workflowComplete?: {
    status: "success" | "error";
    output?: unknown;
    error?: string;
    startTime: number;
  };
};

/**
 * Extended input type for steps that may handle workflow completion
 */
export type StepInputWithWorkflow = {
  _context?: StepContextWithWorkflow;
};

/**
 * Wrap step logic with logging
 * Call this from inside your step function (within "use step" context)
 * If _context._workflowComplete is set, also logs workflow completion
 *
 * @example
 * export async function myStep(input: MyInput & StepInput) {
 *   "use step";
 *   return withStepLogging(input, async () => {
 *     // your step logic here
 *     return { success: true, data: ... };
 *   });
 * }
 */
export function withStepLogging<TInput extends StepInput, TOutput>(
  input: TInput,
  stepLogic: () => Promise<TOutput>
): Promise<TOutput> {
  // Extract context and log input without _context
  const context = input._context as StepContextWithWorkflow | undefined;
  const loggedInput = stripContext(input);

  // Enter ALS scope so any logUserError/logSystemError inside the plugin
  // step automatically picks up org/owner/workflow/plugin labels.
  if (context) {
    const integrationId = (input as Record<string, unknown>).integrationId;
    return runWithWorkflowErrorContext(
      errorContextFromStep(context, integrationId),
      () => withStepLoggingInner(loggedInput, context, stepLogic)
    );
  }
  return withStepLoggingInner(loggedInput, context, stepLogic);
}

async function withStepLoggingInner<TInput extends StepInput, TOutput>(
  loggedInput: Omit<TInput, "_context">,
  context: StepContextWithWorkflow | undefined,
  stepLogic: () => Promise<TOutput>
): Promise<TOutput> {
  // Update progress: mark this step as currently running
  if (context?.executionId && context.nodeId) {
    try {
      await updateCurrentStep({
        executionId: context.executionId,
        currentNodeId: context.nodeId,
        currentNodeName: context.nodeName,
      });
    } catch (err) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[stepHandler] Failed to update current step",
        err
      );
    }
  }

  const logInfo = await logStepStart(context, loggedInput);

  try {
    const result = await stepLogic();

    // Check if result indicates an error
    const isErrorResult =
      result &&
      typeof result === "object" &&
      "success" in result &&
      (result as { success: boolean }).success === false;

    if (isErrorResult) {
      const errorResult = result as { success: false; error?: string };
      await logStepComplete(
        logInfo,
        "error",
        result,
        errorResult.error || "Step execution failed",
        context?.executionId
      );

      recordStepMetrics({
        executionId: context?.executionId,
        nodeId: context?.nodeId || "",
        nodeName: context?.nodeName || "",
        stepType: context?.nodeType || "unknown",
        durationMs: Date.now() - logInfo.startTime,
        success: false,
        error: errorResult.error,
      });
    } else {
      await logStepComplete(
        logInfo,
        "success",
        result,
        undefined,
        context?.executionId
      );

      if (context?.executionId && context.nodeId) {
        recordStepSuccess(context.executionId, context.nodeId, result);
      }

      recordStepMetrics({
        executionId: context?.executionId,
        nodeId: context?.nodeId || "",
        nodeName: context?.nodeName || "",
        stepType: context?.nodeType || "unknown",
        durationMs: Date.now() - logInfo.startTime,
        success: true,
      });
    }

    // Update progress: increment completed steps
    if (context?.executionId && context.nodeId) {
      try {
        await incrementCompletedSteps({
          executionId: context.executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          success: !isErrorResult,
        });
      } catch (err) {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[stepHandler] Failed to increment completed steps",
          err
        );
      }
    }

    // If this step should also log workflow completion, do it now
    if (context?._workflowComplete && context.executionId) {
      await logWorkflowComplete({
        executionId: context.executionId,
        ...context._workflowComplete,
      });
    }

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await logStepComplete(
      logInfo,
      "error",
      undefined,
      errorMessage,
      context?.executionId
    );

    recordStepMetrics({
      executionId: context?.executionId,
      nodeId: context?.nodeId || "",
      nodeName: context?.nodeName || "",
      stepType: context?.nodeType || "unknown",
      durationMs: Date.now() - logInfo.startTime,
      success: false,
      error: errorMessage,
    });

    // Update progress on error too
    if (context?.executionId && context.nodeId) {
      try {
        await incrementCompletedSteps({
          executionId: context.executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          success: false,
        });
      } catch (err) {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[stepHandler] Failed to increment completed steps",
          err
        );
      }
    }

    throw error;
  }
}
