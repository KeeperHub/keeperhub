import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { validateWorkflowIntegrations } from "../lib/db/integrations";
import { buildExecutorInput } from "../lib/workflow/executor/build-executor-input";
import { executeWorkflow } from "../lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow/store";
import { loadWorkflowForExecution } from "../lib/workflow/load-for-execution";
import type { ApiExecuteTriggerType } from "./api-execute";
import type { DbSchema } from "./lib/db-helpers";
import {
  applyExecutionResult,
  initializeExecutionProgress,
  updateExecutionStatus,
  updateScheduleStatus,
} from "./lib/db-helpers";

/**
 * Execute a workflow in-process (no K8s Job).
 * Refactored from keeperhub-executor/workflow-runner.ts main() to be callable
 * from the executor without managing its own process lifecycle.
 */
export async function executeInProcess(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: ApiExecuteTriggerType;
  scheduleId?: string;
  db: PostgresJsDatabase<DbSchema>;
}): Promise<void> {
  const { workflowId, executionId, input, triggerType, scheduleId, db } =
    params;
  const startTime = Date.now();

  console.log("[Executor:InProcess] Starting workflow execution");
  console.log(`[Executor:InProcess] Workflow ID: ${workflowId}`);
  console.log(`[Executor:InProcess] Execution ID: ${executionId}`);

  try {
    await updateExecutionStatus(db, executionId, "running");

    // Defensive re-check: the dispatcher already gated lifecycle state, but the
    // workflow could have been disabled, soft-deleted, deactivated, or its
    // owning org deactivated between dispatch and execution. Cancel rather than
    // run. The org owns the workflow, so org deactivation is the owner gate.
    //
    // Manual runs are the exception: the editor "Run" button must work on
    // not-yet-enabled drafts, so manual triggers pass requireEnabled: false to
    // match the interactive execute route. That only bypasses the "disabled"
    // reason - deleted/deactivated/org-deactivated still block - so it stays
    // safe. Automated triggers (schedule/event/block/webhook) keep the guard.
    const loaded = await loadWorkflowForExecution(workflowId, {
      requireEnabled: triggerType !== "manual",
    });
    if (loaded.status === "not_found") {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (loaded.status === "not_executable") {
      console.log(
        `[Executor:InProcess] Workflow not executable (${loaded.reason}), skipping: ${workflowId}`
      );
      await updateExecutionStatus(db, executionId, "cancelled");
      return;
    }

    const { workflow, organizationName } = loaded;
    const nodes = workflow.nodes as WorkflowNode[];
    const edges = workflow.edges as WorkflowEdge[];
    const validation = await validateWorkflowIntegrations(
      nodes,
      workflow.organizationId
    );

    if (!validation.valid) {
      throw new Error(
        `Workflow contains invalid integration references: ${validation.invalidIds?.join(", ")}`
      );
    }

    await initializeExecutionProgress(db, executionId, nodes, edges);

    console.log("[Executor:InProcess] Executing workflow...");
    // Intentional direct call (not start() from workflow/api): the executor and
    // K8s runner are standalone processes with no DevKit run-processor, so they
    // run the workflow synchronously to completion here. The DevKit editor hint
    // to "use start()" only applies inside the Next runtime. Tradeoff: there is
    // no checkpoint/resume, so a crash mid-run leaves the row "running" until a
    // sweeper closes it - tracked separately from this dedup work.
    const result = await executeWorkflow(
      buildExecutorInput(workflow, {
        triggerInput: input,
        executionId,
        organizationName,
      })
    );

    const duration = Date.now() - startTime;
    console.log(`[Executor:InProcess] Completed in ${duration}ms`);

    // executeWorkflow is the authoritative writer of the terminal status (with
    // reconciliation and richer fields). applyExecutionResult is a guarded
    // backstop: the WHERE clause in updateExecutionStatus makes its writes a
    // no-op once the engine's own write landed, and only closes the row if
    // that write was lost - so a finished run is never left stuck "running".
    const { errorMessage } = await applyExecutionResult(db, executionId, result, {
      scheduleId,
    });
    if (errorMessage) {
      console.error("[Executor:InProcess] Workflow execution failed:", errorMessage);
    } else {
      console.log("[Executor:InProcess] Execution completed successfully");
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    console.error(
      `[Executor:InProcess] Fatal error after ${duration}ms:`,
      errorMessage
    );

    try {
      await updateExecutionStatus(db, executionId, "error", {
        error: errorMessage,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "error", errorMessage);
      }
    } catch (updateError) {
      console.error(
        "[Executor:InProcess] Failed to update execution status:",
        updateError
      );
    }
  }
}
