#!/usr/bin/env tsx
/**
 * Test harness for workflow-runner integration tests
 *
 * This script simulates the key behaviors of workflow-runner for testing:
 * - Signal handling (SIGTERM, SIGINT)
 * - Exit code semantics
 * - Graceful shutdown
 *
 * Usage: tsx workflow-runner-harness.ts <scenario>
 *
 * Scenarios:
 *   success              - Successful workflow completion (exit 0)
 *   workflow-failure     - Workflow fails but result recorded (exit 0)
 *   db-failure           - Database connection/update fails (exit 1)
 *   unhandled-error      - Unhandled exception (exit 1)
 *   long-running         - Long-running workflow for signal testing
 *   slow-shutdown        - Slow shutdown to test timeout
 *   quick-shutdown       - Quick shutdown with no cleanup
 *   missing-workflow-id  - Missing WORKFLOW_ID env var (exit 1)
 *   missing-execution-id - Missing EXECUTION_ID env var (exit 1)
 *   missing-database-url - Missing DATABASE_URL env var (exit 1)
 */

// Graceful shutdown state (mirrors workflow-runner.ts)
let isShuttingDown = false;
let currentExecutionId: string | null = null;

/**
 * Handle graceful shutdown (mirrors workflow-runner.ts implementation)
 */
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
  }, 25_000);

  try {
    // Simulate updating execution status
    if (currentExecutionId) {
      console.log(
        `[Runner] Updating execution ${currentExecutionId} status to error`
      );
      // Simulate DB update delay
      await sleep(100);
    }

    // Simulate closing database connection
    await sleep(50);
    console.log("[Runner] Database connection closed");
  } catch (error) {
    console.error("[Runner] Error during graceful shutdown:", error);
  } finally {
    clearTimeout(shutdownTimeout);
    console.log("[Runner] Graceful shutdown complete");
    // Small delay to ensure output is flushed before exit
    await sleep(50);
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scenario: Successful workflow
 */
async function runSuccess(): Promise<void> {
  currentExecutionId = "exec_test_success";

  console.log("[Runner] Starting workflow execution");
  console.log("[Runner] Workflow ID: wf_test123");
  console.log(`[Runner] Execution ID: ${currentExecutionId}`);

  // Simulate workflow execution
  await sleep(200);

  console.log("[Runner] Workflow completed in 200ms");
  console.log("[Runner] Success: true");

  // Clear execution ID (workflow completed)
  currentExecutionId = null;

  console.log("[Runner] Execution completed successfully");
  console.log("[Runner] Database connection closed");

  process.exit(0);
}

/**
 * Scenario: Workflow failure (business logic)
 */
async function runWorkflowFailure(): Promise<void> {
  currentExecutionId = "exec_test_failure";

  console.log("[Runner] Starting workflow execution");
  console.log("[Runner] Workflow ID: wf_test123");
  console.log(`[Runner] Execution ID: ${currentExecutionId}`);

  // Simulate workflow execution
  await sleep(200);

  console.log("[Runner] Workflow completed in 200ms");
  console.log("[Runner] Success: false");

  // Simulate updating DB with error status
  await sleep(50);

  // Clear execution ID (result recorded)
  currentExecutionId = null;

  // Workflow failure is business logic, not system error
  console.error(
    "[Runner] Workflow execution failed: Step 'http-request' failed"
  );
  console.log("[Runner] Database connection closed");

  // Exit 0 because we successfully recorded the failure
  process.exit(0);
}

/**
 * Scenario: Database failure (system error)
 */
async function runDbFailure(): Promise<void> {
  currentExecutionId = "exec_test_db_failure";

  console.log("[Runner] Starting workflow execution");
  console.log("[Runner] Workflow ID: wf_test123");
  console.log(`[Runner] Execution ID: ${currentExecutionId}`);

  // Simulate connection failure
  await sleep(100);

  console.error("[Runner] Fatal error after 100ms: Connection refused");
  console.error(
    "[Runner] Failed to update execution status: Connection refused"
  );

  // System error - couldn't record result
  process.exit(1);
}

/**
 * Scenario: Unhandled exception
 */
function runUnhandledError(): void {
  currentExecutionId = "exec_test_unhandled";

  console.log("[Runner] Starting workflow execution");

  // Simulate unhandled error
  throw new Error("Unhandled exception in workflow runner");
}

/**
 * Scenario: Long-running workflow (for signal testing)
 */
async function runLongRunning(): Promise<void> {
  currentExecutionId = "exec_test_long";

  console.log("[Runner] Starting workflow execution");
  console.log("[Runner] Workflow ID: wf_test123");
  console.log(`[Runner] Execution ID: ${currentExecutionId}`);
  console.log("[Runner] Executing workflow...");

  // Run for a long time (will be interrupted by signal)
  for (let i = 0; i < 60; i++) {
    if (isShuttingDown) {
      break;
    }
    await sleep(1000);
    console.log(`[Runner] Still running... (${i + 1}s)`);
  }

  // If we get here without shutdown, exit normally
  currentExecutionId = null;
  console.log("[Runner] Long-running workflow completed");
  console.log("[Runner] Database connection closed");
  process.exit(0);
}

/**
 * Scenario: Slow shutdown (to test timeout)
 */
async function runSlowShutdown(): Promise<void> {
  currentExecutionId = "exec_test_slow";

  console.log("[Runner] Starting workflow execution");
  console.log(`[Runner] Execution ID: ${currentExecutionId}`);

  // Override the shutdown handler with a slow version
  const _originalHandler = handleGracefulShutdown;

  async function slowShutdownHandler(signal: string): Promise<void> {
    if (isShuttingDown) {
      console.log(`[Runner] Already shutting down, ignoring ${signal}`);
      return;
    }

    isShuttingDown = true;
    console.log(`[Runner] Received ${signal}, initiating graceful shutdown...`);

    const shutdownTimeout = setTimeout(() => {
      console.error("[Runner] Graceful shutdown timeout, forcing exit");
      process.exit(1);
    }, 25_000);

    try {
      // Simulate slow DB update (but less than 25s)
      console.log("[Runner] Simulating slow database update...");
      await sleep(5000);

      console.log("[Runner] Database connection closed");
    } catch (error) {
      console.error("[Runner] Error during graceful shutdown:", error);
    } finally {
      clearTimeout(shutdownTimeout);
      console.log("[Runner] Graceful shutdown complete");
      process.exit(1);
    }
  }

  // Replace handler
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.on("SIGTERM", () => slowShutdownHandler("SIGTERM"));
  process.on("SIGINT", () => slowShutdownHandler("SIGINT"));

  // Wait for signal
  console.log("[Runner] Waiting for signal...");
  await sleep(60_000);
}

/**
 * Scenario: Quick shutdown
 */
async function runQuickShutdown(): Promise<void> {
  currentExecutionId = "exec_test_quick";

  console.log("[Runner] Starting workflow execution");
  console.log(`[Runner] Execution ID: ${currentExecutionId}`);

  // Wait for signal
  console.log("[Runner] Waiting for signal...");
  await sleep(60_000);
}

/**
 * Scenario: Missing WORKFLOW_ID
 */
function runMissingWorkflowId(): void {
  // Simulate validateEnv() check
  const workflowId = undefined;

  if (!workflowId) {
    console.error("[Runner] WORKFLOW_ID environment variable is required");
    process.exit(1);
  }
}

/**
 * Scenario: Missing EXECUTION_ID
 */
function runMissingExecutionId(): void {
  // Simulate validateEnv() check
  const executionId = undefined;

  if (!executionId) {
    console.error("[Runner] EXECUTION_ID environment variable is required");
    process.exit(1);
  }
}

/**
 * Scenario: Missing DATABASE_URL
 */
function runMissingDatabaseUrl(): void {
  // Simulate DATABASE_URL check
  const connectionString = undefined;

  if (!connectionString) {
    console.error("[Runner] DATABASE_URL environment variable is required");
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const scenario = process.argv[2];

  if (!scenario) {
    console.error("Usage: tsx workflow-runner-harness.ts <scenario>");
    console.error(
      "Scenarios: success, workflow-failure, db-failure, unhandled-error,"
    );
    console.error("           long-running, slow-shutdown, quick-shutdown,");
    console.error(
      "           missing-workflow-id, missing-execution-id, missing-database-url"
    );
    process.exit(1);
  }

  switch (scenario) {
    case "success":
      await runSuccess();
      break;
    case "workflow-failure":
      await runWorkflowFailure();
      break;
    case "db-failure":
      await runDbFailure();
      break;
    case "unhandled-error":
      await runUnhandledError();
      break;
    case "long-running":
      await runLongRunning();
      break;
    case "slow-shutdown":
      await runSlowShutdown();
      break;
    case "quick-shutdown":
      await runQuickShutdown();
      break;
    case "missing-workflow-id":
      await runMissingWorkflowId();
      break;
    case "missing-execution-id":
      await runMissingExecutionId();
      break;
    case "missing-database-url":
      await runMissingDatabaseUrl();
      break;
    default:
      console.error(`Unknown scenario: ${scenario}`);
      process.exit(1);
  }
}

// Run main and handle unhandled errors
main().catch((error) => {
  console.error("[Runner] Unhandled error:", error);
  process.exit(1);
});
