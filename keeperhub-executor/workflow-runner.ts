/**
 * Workflow Runner Script
 *
 * Executes a single workflow in an isolated K8s Job container.
 * Receives workflow context via environment variables, executes the workflow,
 * updates the database, and exits.
 *
 * Usage (via bootstrap script that patches 'server-only'):
 *   tsx keeperhub-executor/workflow-runner-bootstrap.ts
 *
 * Usage (in Docker container where 'server-only' is already shimmed):
 *   tsx keeperhub-executor/workflow-runner.ts
 *
 * Environment variables (required):
 *   WORKFLOW_ID - ID of the workflow to execute
 *   EXECUTION_ID - ID of the execution record (pre-created by executor)
 *   DATABASE_URL - PostgreSQL connection string
 *   INTEGRATION_ENCRYPTION_KEY - Key for decrypting integration credentials
 *
 * Environment variables (optional):
 *   WORKFLOW_INPUT - JSON string of trigger input (default: {})
 *   SCHEDULE_ID - ID of the schedule (for scheduled executions)
 *   + system credentials from runner-env.ts (ETHERSCAN_API_KEY, etc.)
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { validateWorkflowIntegrations } from "../lib/db/integrations";
import {
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "../lib/db/schema";
import { buildExecutorInput } from "../lib/workflow/executor/build-executor-input";
import { executeWorkflow } from "../lib/workflow/executor/executor.workflow";
import { SHUTDOWN_TIMEOUT_MS } from "../lib/workflow/executor/runner-constants";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow/store";
import { loadWorkflowForExecution } from "../lib/workflow/load-for-execution";
import type { ApiExecuteTriggerType } from "./api-execute";
import {
  applyExecutionResult,
  initializeExecutionProgress,
  updateExecutionStatus,
  updateScheduleStatus,
} from "./lib/db-helpers";
import { shipMetricsToExecutor } from "./lib/ship-metrics";

// Validate required environment variables
function validateEnv(): {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType?: ApiExecuteTriggerType;
  scheduleId?: string;
} {
  const workflowId = process.env.WORKFLOW_ID;
  const executionId = process.env.EXECUTION_ID;

  if (!workflowId) {
    console.error("[Runner] WORKFLOW_ID environment variable is required");
    process.exit(1);
  }

  if (!executionId) {
    console.error("[Runner] EXECUTION_ID environment variable is required");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("[Runner] DATABASE_URL environment variable is required");
    process.exit(1);
  }

  let input: Record<string, unknown> = {};
  if (process.env.WORKFLOW_INPUT) {
    try {
      input = JSON.parse(process.env.WORKFLOW_INPUT);
    } catch (error) {
      console.error("[Runner] Failed to parse WORKFLOW_INPUT:", error);
      process.exit(1);
    }
  }

  return {
    workflowId,
    executionId,
    input,
    triggerType: process.env.TRIGGER_TYPE as ApiExecuteTriggerType | undefined,
    scheduleId: process.env.SCHEDULE_ID,
  };
}

// Database connection with timeout configuration
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}
const queryClient = postgres(connectionString, {
  connect_timeout: 10,
  idle_timeout: 30,
  max_lifetime: 60 * 5,
  connection: { statement_timeout: 30_000 },
});
const db = drizzle(queryClient, {
  schema: { workflows, workflowExecutions, workflowSchedules },
});

// Graceful shutdown state tracking
let isShuttingDown = false;
let currentExecutionId: string | null = null;
let currentScheduleId: string | null = null;

// A SIGTERM that lands while the workflow is finishing lets both the shutdown
// handler and main()'s finally reach the end of the run. collectCounterDeltas
// reads absolute counter values with no last-shipped baseline, so a second
// shipment would re-send everything the first one did: the two paths share one
// shipment rather than each starting their own.
let metricsShipment: Promise<void> | null = null;

// The promise for the shutdown the first signal started. main() waits on it
// instead of returning, because returning runs the top-level process.exit and
// would kill the pod out from under a shutdown that has not written its
// terminal status yet - the write whose counters this all exists to ship.
let shutdownCompletion: Promise<void> | null = null;

function shipMetricsOnce(): Promise<void> {
  if (!metricsShipment) {
    metricsShipment = shipMetricsToExecutor();
  }
  return metricsShipment;
}

async function handleGracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Runner] Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  console.log(`[Runner] Received ${signal}, initiating graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error("[Runner] Graceful shutdown timeout, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    if (currentExecutionId) {
      console.log(
        `[Runner] Updating execution ${currentExecutionId} status to error`
      );
      await updateExecutionStatus(db, currentExecutionId, "error", {
        error: `Workflow terminated by ${signal} signal`,
      });

      if (currentScheduleId) {
        await updateScheduleStatus(
          db,
          currentScheduleId,
          "error",
          `Workflow terminated by ${signal} signal`
        );
      }
    }

    await queryClient.end();
    console.log("[Runner] Database connection closed");
  } catch (error) {
    console.error("[Runner] Error during graceful shutdown:", error);
  } finally {
    // The status write above incremented the terminal counters in this
    // process; they only reach the executor if shipped before exit. Shipping
    // is bounded by its own fetch timeout, and the forced-exit timer stays
    // armed until it resolves.
    await shipMetricsOnce();
    clearTimeout(shutdownTimeout);
    console.log("[Runner] Graceful shutdown complete");
    process.exit(1);
  }
}

// Keep the FIRST shutdown's promise: a later signal returns the early-exit
// path, which settles immediately and would release main() while the real
// shutdown is still mid-flight.
function onShutdownSignal(signal: string): Promise<void> {
  const completion = handleGracefulShutdown(signal);
  shutdownCompletion ??= completion;
  return completion;
}

process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
process.on("SIGINT", () => onShutdownSignal("SIGINT"));

async function main(): Promise<void> {
  const startTime = Date.now();
  const { workflowId, executionId, input, triggerType, scheduleId } =
    validateEnv();

  currentExecutionId = executionId;
  currentScheduleId = scheduleId ?? null;

  console.log("[Runner] Starting workflow execution");
  console.log(`[Runner] Workflow ID: ${workflowId}`);
  console.log(`[Runner] Execution ID: ${executionId}`);
  console.log(`[Runner] Schedule ID: ${scheduleId || "none"}`);

  try {
    if (isShuttingDown) {
      console.log("[Runner] Shutdown in progress, aborting execution");
      return;
    }

    await updateExecutionStatus(db, executionId, "running");

    // Defensive re-check: the dispatcher already gated lifecycle state, but the
    // workflow could have been disabled, soft-deleted, deactivated, or its
    // owning org deactivated between dispatch and pod startup. Cancel rather
    // than run. The org owns the workflow, so org deactivation is the owner gate.
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
        `[Runner] Workflow not executable (${loaded.reason}), skipping execution: ${workflowId}`
      );
      await updateExecutionStatus(db, executionId, "cancelled");
      return;
    }

    const { workflow, organizationName } = loaded;
    console.log(`[Runner] Loaded workflow: ${workflow.name || workflowId}`);

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
    console.log(`[Runner] Initialized execution progress`);

    if (isShuttingDown) {
      console.log("[Runner] Shutdown requested, aborting before execution");
      return;
    }

    console.log("[Runner] Executing workflow...");
    // Intentional direct call (not start() from workflow/api): this runner is a
    // standalone K8s-job process with no DevKit run-processor, so the pod itself
    // is the execution boundary and runs the workflow synchronously here. The
    // DevKit editor hint to "use start()" only applies inside the Next runtime.
    // Tradeoff: no checkpoint/resume - with backoffLimit:0 a crashed pod leaves
    // the row "running" until a sweeper closes it, tracked separately.
    const result = await executeWorkflow(
      buildExecutorInput(workflow, {
        triggerInput: input,
        executionId,
        organizationName,
      })
    );

    const duration = Date.now() - startTime;
    console.log(`[Runner] Workflow completed in ${duration}ms`);
    console.log(`[Runner] Success: ${result.success}`);

    // executeWorkflow is the authoritative writer of the terminal status (with
    // reconciliation and richer fields). applyExecutionResult is a guarded
    // backstop: the WHERE clause in updateExecutionStatus makes its writes a
    // no-op once the engine's own write landed, and only closes the row if
    // that write was lost - so a finished run is never left stuck "running".
    const { errorMessage } = await applyExecutionResult(db, executionId, result, {
      scheduleId,
    });
    currentExecutionId = null;
    if (errorMessage) {
      console.error("[Runner] Workflow execution failed:", errorMessage);
    } else {
      console.log("[Runner] Execution completed successfully");
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    console.error(`[Runner] Fatal error after ${duration}ms:`, errorMessage);

    let dbUpdateSucceeded = false;
    try {
      await updateExecutionStatus(db, executionId, "error", {
        error: errorMessage,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "error", errorMessage);
      }
      dbUpdateSucceeded = true;
    } catch (updateError) {
      console.error("[Runner] Failed to update execution status:", updateError);
      process.exitCode = 1;
    }

    currentExecutionId = null;

    if (dbUpdateSucceeded) {
      console.log("[Runner] Error recorded to database, exiting normally");
    }
  } finally {
    if (isShuttingDown) {
      // The handler owns the rest: it writes the terminal status, ships the
      // counters that write increments, closes the connection and exits.
      // Shipping here instead would send the pre-terminal snapshot and, worse,
      // let main() resolve into process.exit before that write lands.
      await shutdownCompletion;
    } else {
      await shipMetricsOnce();
      await queryClient.end();
      console.log("[Runner] Database connection closed");
    }
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error("[Runner] Unhandled error:", error);
    process.exit(1);
  });
