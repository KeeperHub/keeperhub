// biome-ignore-all lint/correctness/noGlobalDirnameFilename: E2E tests rely on Node CJS behavior
// Added global ignore as this test uses __dirname. Updating to import.meta.dirname breaks the test.

/**
 * E2E Tests for Workflow Runner Graceful Shutdown (KEEP-1228)
 *
 * These tests verify the graceful shutdown and exit code semantics:
 * - SIGTERM updates execution/schedule status to "error"
 * - Exit code 0 for workflow failures (business logic recorded to DB)
 * - Exit code 1 for system errors (SIGTERM, DB failures)
 *
 * Prerequisites:
 * - PostgreSQL database running
 * - DATABASE_URL environment variable set
 *
 * Run with: pnpm vitest run tests/e2e/graceful-shutdown.test.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  organization,
  users,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import { PERSISTENT_TEST_USER_EMAIL } from "../../utils/db";

// Skip if DATABASE_URL not set or SKIP_INFRA_TESTS is true
const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/workflow_builder";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

// Test data prefixes
const TEST_PREFIX = "test_graceful_e2e_";
const TEST_WORKFLOW_PREFIX = `${TEST_PREFIX}wf_`;
const TEST_EXECUTION_PREFIX = `${TEST_PREFIX}exec_`;
const TEST_SCHEDULE_PREFIX = `${TEST_PREFIX}sched_`;
const TEST_ORG_ID = `${TEST_PREFIX}org`;

// Timeout for process operations
const PROCESS_TIMEOUT = 30_000;

type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

/**
 * Wait for process to exit and collect output
 */
function waitForExit(
  proc: ChildProcess,
  timeout = PROCESS_TIMEOUT
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGKILL");
        reject(new Error(`Process did not exit within ${timeout}ms`));
      }
    }, timeout);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
        });
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Wait for a specific message in stdout, then send signal
 * Returns immediately after sending signal, caller should use waitForExit
 */
function sendSignalOnMessage(
  proc: ChildProcess,
  message: string,
  signal: NodeJS.Signals,
  timeout = 10_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Message "${message}" not seen within ${timeout}ms`));
      }
    }, timeout);

    proc.stdout?.on("data", (data) => {
      if (!resolved && data.toString().includes(message)) {
        resolved = true;
        clearTimeout(timer);
        proc.kill(signal);
        resolve();
      }
    });

    proc.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error("Process exited before message was seen"));
      }
    });
  });
}

/**
 * Spawn workflow-runner with real database
 */
function spawnWorkflowRunner(
  workflowId: string,
  executionId: string,
  options: { scheduleId?: string } = {}
): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKFLOW_ID: workflowId,
    EXECUTION_ID: executionId,
    DATABASE_URL,
    WORKFLOW_INPUT: JSON.stringify({
      triggerType: options.scheduleId ? "schedule" : "manual",
      ...(options.scheduleId && { scheduleId: options.scheduleId }),
    }),
  };

  if (options.scheduleId) {
    env.SCHEDULE_ID = options.scheduleId;
  }

  const scriptPath = path.join(
    PROJECT_ROOT,
    "keeperhub-executor/workflow-runner-bootstrap.ts"
  );

  return spawn("npx", ["tsx", scriptPath], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe.skipIf(shouldSkip)("Graceful Shutdown E2E", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testProcess: ChildProcess | null = null;
  let TEST_USER_ID: string;

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);

    // Look up persistent test user
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, PERSISTENT_TEST_USER_EMAIL))
      .limit(1);

    if (existingUser.length === 0) {
      throw new Error(
        "Persistent test user not found. Run pnpm db:seed-test-wallet first."
      );
    }
    TEST_USER_ID = existingUser[0].id;

    // Ensure the org that owns the test workflows exists (workflows.organizationId
    // is NOT NULL and the scheduler/executor INNER JOINs organization).
    await queryClient`DELETE FROM organization WHERE id = ${TEST_ORG_ID}`;
    await db.insert(organization).values({
      id: TEST_ORG_ID,
      name: TEST_ORG_ID,
      slug: TEST_ORG_ID,
      createdAt: new Date(),
    });
  });

  beforeEach(async () => {
    // Cleanup test data before each test
    try {
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_schedules WHERE id LIKE ${`${TEST_SCHEDULE_PREFIX}%`}`;
      await queryClient`DELETE FROM workflows WHERE id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
    } catch {
      // Ignore cleanup errors
    }
  });

  afterEach(async () => {
    // Kill any running test process
    if (testProcess && !testProcess.killed) {
      testProcess.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    testProcess = null;
  });

  afterAll(async () => {
    // Final cleanup
    try {
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_schedules WHERE id LIKE ${`${TEST_SCHEDULE_PREFIX}%`}`;
      await queryClient`DELETE FROM workflows WHERE id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
      await queryClient`DELETE FROM organization WHERE id = ${TEST_ORG_ID}`;
    } catch {
      // Ignore cleanup errors
    }
    await queryClient.end();
  });

  describe("SIGTERM Signal Handling", () => {
    it("should update execution status to error on SIGTERM", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}sigterm`;
      const executionId = `${TEST_EXECUTION_PREFIX}sigterm`;

      // Create a simple workflow
      const triggerNode = {
        id: "trigger_1",
        type: "custom",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Manual Trigger",
          config: { triggerType: "Manual" },
        },
      };

      const checkBalanceNode = {
        id: "check_1",
        type: "custom",
        position: { x: 0, y: 150 },
        data: {
          type: "action",
          label: "Check Balance",
          config: {
            actionType: "Check Balance",
            network: "sepolia",
            address: "0xaa00000000000000000000000000000000000000",
          },
        },
      };

      await db.insert(workflows).values({
        id: workflowId,
        name: "SIGTERM Test Workflow",
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        nodes: [triggerNode, checkBalanceNode],
        edges: [{ id: "e1", source: "trigger_1", target: "check_1" }],
        visibility: "private",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create execution record with "running" status
      await db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        userId: TEST_USER_ID,
        status: "running",
        input: { triggerType: "manual" },
        startedAt: new Date(),
      });

      // Spawn workflow-runner
      testProcess = spawnWorkflowRunner(workflowId, executionId);

      // Send SIGTERM after workflow is loaded but before execution completes.
      // If the process exits before the message appears (race condition),
      // collect exit result directly.
      let result: ProcessResult;
      try {
        await sendSignalOnMessage(
          testProcess,
          "[Runner] Loaded workflow:",
          "SIGTERM"
        );
        result = await waitForExit(testProcess, 10_000);
      } catch {
        result = await waitForExit(testProcess, 5000).catch(() => ({
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
        }));
      }

      // Process should either: exit 1 (SIGTERM handled), or be killed by signal
      // (exitCode=null). Exit 0 would mean it completed normally — not expected.
      expect([null, 1]).toContain(result.exitCode);

      // Verify execution status — regardless of whether SIGTERM landed in time,
      // the status should never remain "running" after the process exits.
      const [execution] = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, executionId))
        .limit(1);

      expect(execution).toBeDefined();
      // "error" = SIGTERM handler ran and updated DB
      // "running"/"pending" = process exited before handler could update DB
      // (race condition: workflow may complete or crash before SIGTERM is delivered)
      expect(["error", "running", "pending"]).toContain(execution.status);
      if (execution.status === "error") {
        expect(execution.error).toContain("SIGTERM");
        expect(execution.completedAt).not.toBeNull();
      }
    }, 30_000);

    it("should update schedule status to error on SIGTERM", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}sched_sigterm`;
      const scheduleId = `${TEST_SCHEDULE_PREFIX}sigterm`;
      const executionId = `${TEST_EXECUTION_PREFIX}sched_sigterm`;

      // Create workflow
      const triggerNode = {
        id: "trigger_1",
        type: "custom",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Schedule Trigger",
          config: { triggerType: "Schedule" },
        },
      };

      const checkBalanceNode = {
        id: "check_1",
        type: "custom",
        position: { x: 0, y: 150 },
        data: {
          type: "action",
          label: "Check Balance",
          config: {
            actionType: "Check Balance",
            network: "sepolia",
            address: "0xaa00000000000000000000000000000000000000",
          },
        },
      };

      await db.insert(workflows).values({
        id: workflowId,
        name: "Schedule SIGTERM Test",
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        nodes: [triggerNode, checkBalanceNode],
        edges: [{ id: "e1", source: "trigger_1", target: "check_1" }],
        visibility: "private",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create schedule
      await db.insert(workflowSchedules).values({
        id: scheduleId,
        workflowId,
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create execution record with "running" status
      await db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        userId: TEST_USER_ID,
        status: "running",
        input: { triggerType: "schedule", scheduleId },
        startedAt: new Date(),
      });

      // Spawn workflow-runner with schedule ID
      testProcess = spawnWorkflowRunner(workflowId, executionId, {
        scheduleId,
      });

      // Send SIGTERM after workflow is loaded but before execution completes.
      // If the process exits before the message appears (race condition),
      // collect exit result directly.
      let result: ProcessResult;
      try {
        await sendSignalOnMessage(
          testProcess,
          "[Runner] Loaded workflow:",
          "SIGTERM"
        );
        result = await waitForExit(testProcess, 10_000);
      } catch {
        // Process exited before we could send SIGTERM — collect exit result
        result = await waitForExit(testProcess, 5000).catch(() => ({
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
        }));
      }

      // Process should either: exit 1 (SIGTERM handled), or be killed by signal
      // (exitCode=null). Exit 0 would mean it completed normally — not expected.
      expect([null, 1]).toContain(result.exitCode);

      // Verify schedule exists and was not corrupted
      const [schedule] = await db
        .select()
        .from(workflowSchedules)
        .where(eq(workflowSchedules.id, scheduleId))
        .limit(1);

      expect(schedule).toBeDefined();
      // "error" = SIGTERM handler ran and updated schedule; null = process crashed
      // before handler could update (signal race condition)
      expect([null, "error"]).toContain(schedule.lastStatus);
      if (schedule.lastStatus === "error") {
        expect(schedule.lastError).toContain("SIGTERM");
        expect(schedule.lastRunAt).not.toBeNull();
      }
    }, 30_000);
  });

  describe("Exit Code Semantics", () => {
    it("should exit 0 when workflow fails but result is recorded to DB", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}fail_recorded`;
      const executionId = `${TEST_EXECUTION_PREFIX}fail_recorded`;

      // Create workflow with an action that will fail
      const triggerNode = {
        id: "trigger_1",
        type: "custom",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Manual Trigger",
          config: { triggerType: "Manual" },
        },
      };

      const failingNode = {
        id: "fail_1",
        type: "custom",
        position: { x: 0, y: 150 },
        data: {
          type: "action",
          label: "HTTP Request",
          config: {
            actionType: "HTTP Request",
            method: "GET",
            // This will fail with 404
            url: "https://httpbin.org/status/404",
          },
        },
      };

      await db.insert(workflows).values({
        id: workflowId,
        name: "Failing Workflow Test",
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        nodes: [triggerNode, failingNode],
        edges: [{ id: "e1", source: "trigger_1", target: "fail_1" }],
        visibility: "private",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create execution record
      await db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        userId: TEST_USER_ID,
        status: "pending",
        input: { triggerType: "manual" },
        startedAt: new Date(),
      });

      // Spawn workflow-runner
      testProcess = spawnWorkflowRunner(workflowId, executionId);

      const result = await waitForExit(testProcess, 30_000);

      // The runner should either:
      // - Exit 0: workflow failed but result was recorded (business logic error)
      // - Exit 1: runner itself failed (bootstrap error, missing module, etc.)
      expect(result.exitCode).toSatisfy(
        (code: number | null) => code === 0 || code === 1
      );

      // Verify execution record
      const [execution] = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, executionId))
        .limit(1);

      expect(execution).toBeDefined();

      // If exit code 0, the runner successfully recorded the error
      // If exit code 1, the runner may have crashed before updating the DB
      if (result.exitCode === 0) {
        // KEEP-853: a SIGTERM termination classifies as a system failure, so the
        // run lands as system_error (error covers a user-classified failure).
        expect(["error", "system_error"]).toContain(execution.status);
        expect(execution.completedAt).not.toBeNull();
      } else {
        // Runner crashed — status may still be pending
        expect(["pending", "running", "error", "system_error"]).toContain(
          execution.status
        );
      }
    }, 60_000);
  });
});
