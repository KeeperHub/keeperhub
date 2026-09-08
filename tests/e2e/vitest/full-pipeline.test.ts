/* biome-ignore-all lint/correctness/noGlobalDirnameFilename: vitest requires __dirname */

/**
 * Full Pipeline E2E Tests
 *
 * Tests the complete workflow execution pipeline:
 * 1. Manual Trigger: API → SQS → Job Spawner → Workflow Runner
 * 2. Schedule Trigger: Dispatcher → SQS → Job Spawner → Workflow Runner
 *
 * These tests verify the real infrastructure integration:
 * - SQS message flow (LocalStack)
 * - Database operations
 * - Workflow execution with user RPC preferences
 *
 * Note: K8s job creation is simulated by running workflow-runner directly,
 * since actual K8s cluster may not be available in test environments.
 *
 * Prerequisites:
 * - PostgreSQL database running
 * - LocalStack with SQS
 * - DATABASE_URL, AWS_ENDPOINT_URL environment variables
 *
 * Run with: pnpm vitest tests/e2e/full-pipeline.test.ts
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chains,
  organization,
  userRpcPreferences,
  users,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "../../../lib/db/schema";
import { PERSISTENT_TEST_USER_EMAIL } from "../../utils/db";

// Skip tests if infrastructure isn't available
const SKIP_INFRA_TESTS =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/workflow_builder";
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL || "http://localhost:4566";

// Test data prefixes
const TEST_PREFIX = "test_pipeline_e2e_";
const TEST_WORKFLOW_PREFIX = `${TEST_PREFIX}wf_`;
const TEST_EXECUTION_PREFIX = `${TEST_PREFIX}exec_`;
const TEST_SCHEDULE_PREFIX = `${TEST_PREFIX}sched_`;
const TEST_ORG_ID = `${TEST_PREFIX}org`;
const TEST_QUEUE_NAME = "keeperhub-pipeline-test-queue";

// Test RPC URLs
const CUSTOM_PRIMARY_RPC = "https://chain.techops.services/eth-sepolia";
const TEST_ADDRESS = "0xaa00000000000000000000000000000000000000";

// Message types matching the pipeline
type ScheduleMessage = {
  workflowId: string;
  scheduleId?: string;
  executionId?: string;
  triggerTime: string;
  triggerType: "schedule" | "manual";
};

describe.skipIf(SKIP_INFRA_TESTS)("Full Pipeline E2E", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let sqsClient: SQSClient;
  let testQueueUrl: string;
  let TEST_USER_ID: string;

  beforeAll(async () => {
    // Connect to database
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient, {
      schema: {
        organization,
        users,
        workflows,
        workflowExecutions,
        workflowSchedules,
        chains,
        userRpcPreferences,
      },
    });

    // Create SQS client for LocalStack
    sqsClient = new SQSClient({
      region: "us-east-1",
      endpoint: AWS_ENDPOINT,
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });

    // Create dedicated test queue
    try {
      const createResult = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: TEST_QUEUE_NAME,
        })
      );
      testQueueUrl = createResult.QueueUrl || "";
      testQueueUrl = testQueueUrl.replace(
        "host.minikube.internal",
        "localhost"
      );
    } catch {
      testQueueUrl = `${AWS_ENDPOINT}/000000000000/${TEST_QUEUE_NAME}`;
    }

    // Ensure Sepolia chain exists
    const existingChain = await db
      .select()
      .from(chains)
      .where(eq(chains.chainId, 11_155_111))
      .limit(1);

    if (existingChain.length === 0) {
      await db.insert(chains).values({
        chainId: 11_155_111,
        name: "Sepolia Testnet",
        symbol: "ETH",
        chainType: "evm",
        defaultPrimaryRpc: "https://ethereum-sepolia-rpc.publicnode.com",
        defaultFallbackRpc: "https://ethereum-sepolia.publicnode.com",
        isTestnet: true,
        isEnabled: true,
      });
    } else {
      // Update existing chain with reliable RPC URLs
      await db
        .update(chains)
        .set({
          defaultPrimaryRpc: "https://ethereum-sepolia-rpc.publicnode.com",
          defaultFallbackRpc: "https://ethereum-sepolia.publicnode.com",
        })
        .where(eq(chains.chainId, 11_155_111));
    }

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
    // Clean up test data
    try {
      // Delete execution logs for test executions and any executions linked to test workflows
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id IN (SELECT id FROM workflow_executions WHERE workflow_id LIKE ${`${TEST_WORKFLOW_PREFIX}%`})`;
      // Delete executions by ID prefix and by workflow_id (for app/runner created executions)
      await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_executions WHERE workflow_id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_schedules WHERE id LIKE ${`${TEST_SCHEDULE_PREFIX}%`}`;
      await queryClient`DELETE FROM workflows WHERE id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
      await db
        .delete(userRpcPreferences)
        .where(eq(userRpcPreferences.userId, TEST_USER_ID));

      // Purge test queue
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: testQueueUrl }));
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    // Final cleanup
    try {
      // Delete execution logs for test executions and any executions linked to test workflows
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id IN (SELECT id FROM workflow_executions WHERE workflow_id LIKE ${`${TEST_WORKFLOW_PREFIX}%`})`;
      // Delete executions by ID prefix and by workflow_id (for app/runner created executions)
      await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_executions WHERE workflow_id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_schedules WHERE id LIKE ${`${TEST_SCHEDULE_PREFIX}%`}`;
      await queryClient`DELETE FROM workflows WHERE id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
      await queryClient`DELETE FROM organization WHERE id = ${TEST_ORG_ID}`;
      await db
        .delete(userRpcPreferences)
        .where(eq(userRpcPreferences.userId, TEST_USER_ID));
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: testQueueUrl }));
    } catch (error) {
      console.warn("Cleanup warning:", error);
    }

    await queryClient.end();
  });

  /**
   * Helper to create a check-balance workflow
   */
  async function createCheckBalanceWorkflow(id: string): Promise<string> {
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
      id: "check_balance_1",
      type: "custom",
      position: { x: 0, y: 150 },
      data: {
        type: "action",
        label: "Check Balance",
        config: {
          actionType: "Check Balance",
          network: "sepolia",
          address: TEST_ADDRESS,
        },
      },
    };

    await db.insert(workflows).values({
      id,
      name: `Test Pipeline Workflow ${id}`,
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      nodes: [triggerNode, checkBalanceNode],
      edges: [{ id: "e1", source: "trigger_1", target: "check_balance_1" }],
      visibility: "private",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return id;
  }

  /**
   * Helper to run workflow-runner script (simulates K8s job)
   */
  async function runWorkflowRunner(
    workflowId: string,
    executionId: string,
    options: { scheduleId?: string; timeout?: number } = {}
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        WORKFLOW_ID: workflowId,
        EXECUTION_ID: executionId,
        DATABASE_URL,
        WORKFLOW_INPUT: JSON.stringify({
          triggerType: options.scheduleId ? "schedule" : "manual",
          ...(options.scheduleId && { scheduleId: options.scheduleId }),
        }),
        ...(options.scheduleId && { SCHEDULE_ID: options.scheduleId }),
      };

      const scriptPath = join(
        import.meta.dirname,
        "../../../keeperhub-executor/workflow-runner-bootstrap.ts"
      );
      const child = spawn("npx", ["tsx", scriptPath], {
        env,
        cwd: join(import.meta.dirname, "../../.."),
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      const timeout = options.timeout || 60_000;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ exitCode: null, stdout, stderr: `${stderr}\nTimeout` });
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr });
      });
    });
  }

  describe("Manual Trigger Pipeline", () => {
    const PIPELINE_TIMEOUT = 90_000;

    it(
      "should send manual trigger message to SQS and process execution",
      async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}manual_trigger`;
        const executionId = `${TEST_EXECUTION_PREFIX}manual_trigger`;

        // Step 1: Create workflow
        await createCheckBalanceWorkflow(workflowId);

        // Step 2: Send message to SQS (simulating manual trigger from UI)
        const message: ScheduleMessage = {
          workflowId,
          executionId,
          triggerTime: new Date().toISOString(),
          triggerType: "manual",
        };

        const sendResult = await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: testQueueUrl,
            MessageBody: JSON.stringify(message),
            MessageAttributes: {
              TriggerType: {
                DataType: "String",
                StringValue: "manual",
              },
              WorkflowId: {
                DataType: "String",
                StringValue: workflowId,
              },
            },
          })
        );

        expect(sendResult.MessageId).toBeDefined();
        console.log(`[Test] Sent SQS message: ${sendResult.MessageId}`);

        // Step 3: Receive message from SQS (simulating job-spawner)
        const receiveResult = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: testQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
          })
        );

        expect(receiveResult.Messages).toBeDefined();
        expect(receiveResult.Messages?.length).toBeGreaterThan(0);

        const receivedMessage = JSON.parse(
          receiveResult.Messages?.[0].Body || "{}"
        );
        expect(receivedMessage.workflowId).toBe(workflowId);
        expect(receivedMessage.triggerType).toBe("manual");

        // Delete message (job-spawner would do this after creating job)
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: testQueueUrl,
            ReceiptHandle: receiveResult.Messages?.[0].ReceiptHandle,
          })
        );

        // Step 4: Create execution record (job-spawner creates this)
        await db.insert(workflowExecutions).values({
          id: executionId,
          workflowId,
          userId: TEST_USER_ID,
          status: "pending",
          input: { triggerType: "manual" },
          startedAt: new Date(),
        });

        // Step 5: Run workflow-runner (simulates K8s job)
        const result = await runWorkflowRunner(workflowId, executionId, {
          timeout: PIPELINE_TIMEOUT,
        });

        // Step 6: Verify execution succeeded
        expect(result.exitCode).toBe(0);

        const execution = await db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        expect(execution[0]?.status).toBe("success");
        expect(execution[0]?.completedAt).toBeDefined();
      },
      PIPELINE_TIMEOUT
    );

    it(
      "should use user RPC preferences through the full pipeline",
      async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}manual_rpc_pref`;
        const executionId = `${TEST_EXECUTION_PREFIX}manual_rpc_pref`;

        // Step 1: Set user RPC preferences
        await db.insert(userRpcPreferences).values({
          userId: TEST_USER_ID,
          chainId: 11_155_111,
          primaryRpcUrl: CUSTOM_PRIMARY_RPC,
          fallbackRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
        });

        // Step 2: Create workflow
        await createCheckBalanceWorkflow(workflowId);

        // Step 3: Send to SQS
        const message: ScheduleMessage = {
          workflowId,
          executionId,
          triggerTime: new Date().toISOString(),
          triggerType: "manual",
        };

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: testQueueUrl,
            MessageBody: JSON.stringify(message),
          })
        );

        // Step 4: Receive and process
        const receiveResult = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: testQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
          })
        );

        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: testQueueUrl,
            ReceiptHandle: receiveResult.Messages?.[0].ReceiptHandle,
          })
        );

        // Step 5: Create execution record
        await db.insert(workflowExecutions).values({
          id: executionId,
          workflowId,
          userId: TEST_USER_ID,
          status: "pending",
          input: { triggerType: "manual" },
          startedAt: new Date(),
        });

        // Step 6: Run workflow-runner
        const result = await runWorkflowRunner(workflowId, executionId, {
          timeout: PIPELINE_TIMEOUT,
        });

        // Step 7: Verify user RPC preferences were used
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          "Using user RPC preferences for userId"
        );

        const execution = await db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        expect(execution[0]?.status).toBe("success");
      },
      PIPELINE_TIMEOUT
    );
  });

  describe("Schedule Trigger Pipeline", () => {
    const PIPELINE_TIMEOUT = 90_000;

    it(
      "should create schedule and execute via dispatcher flow",
      async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}schedule_trigger`;
        const scheduleId = `${TEST_SCHEDULE_PREFIX}schedule_trigger`;
        const executionId = `${TEST_EXECUTION_PREFIX}schedule_trigger`;

        // Step 1: Create workflow
        await createCheckBalanceWorkflow(workflowId);

        // Step 2: Create schedule
        await db.insert(workflowSchedules).values({
          id: scheduleId,
          workflowId,
          cronExpression: "* * * * *", // Every minute
          timezone: "UTC",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Verify schedule was created
        const schedule = await db
          .select()
          .from(workflowSchedules)
          .where(eq(workflowSchedules.id, scheduleId))
          .limit(1);

        expect(schedule.length).toBe(1);
        expect(schedule[0].enabled).toBe(true);

        // Step 3: Simulate dispatcher sending message to SQS
        const message: ScheduleMessage = {
          workflowId,
          scheduleId,
          triggerTime: new Date().toISOString(),
          triggerType: "schedule",
        };

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: testQueueUrl,
            MessageBody: JSON.stringify(message),
            MessageAttributes: {
              TriggerType: {
                DataType: "String",
                StringValue: "schedule",
              },
              WorkflowId: {
                DataType: "String",
                StringValue: workflowId,
              },
            },
          })
        );

        // Step 4: Receive message (simulating job-spawner)
        const receiveResult = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: testQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
          })
        );

        expect(receiveResult.Messages?.length).toBeGreaterThan(0);

        const receivedMessage = JSON.parse(
          receiveResult.Messages?.[0].Body || "{}"
        );
        expect(receivedMessage.scheduleId).toBe(scheduleId);
        expect(receivedMessage.triggerType).toBe("schedule");

        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: testQueueUrl,
            ReceiptHandle: receiveResult.Messages?.[0].ReceiptHandle,
          })
        );

        // Step 5: Create execution record (job-spawner does this)
        await db.insert(workflowExecutions).values({
          id: executionId,
          workflowId,
          userId: TEST_USER_ID,
          status: "pending",
          input: {
            triggerType: "schedule",
            scheduleId,
            triggerTime: message.triggerTime,
          },
          startedAt: new Date(),
        });

        // Step 6: Run workflow-runner with schedule ID
        const result = await runWorkflowRunner(workflowId, executionId, {
          scheduleId,
          timeout: PIPELINE_TIMEOUT,
        });

        // Step 7: Verify execution succeeded
        expect(result.exitCode).toBe(0);

        const execution = await db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        expect(execution[0]?.status).toBe("success");

        // Step 8: Verify schedule was updated
        const updatedSchedule = await db
          .select()
          .from(workflowSchedules)
          .where(eq(workflowSchedules.id, scheduleId))
          .limit(1);

        expect(updatedSchedule[0]?.lastRunAt).toBeDefined();
        expect(updatedSchedule[0]?.lastStatus).toBe("success");
      },
      PIPELINE_TIMEOUT
    );

    it("should update schedule status on execution failure", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}schedule_fail`;
      const scheduleId = `${TEST_SCHEDULE_PREFIX}schedule_fail`;
      const executionId = `${TEST_EXECUTION_PREFIX}schedule_fail`;

      // Create workflow with bad action
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

      const badNode = {
        id: "bad_1",
        type: "custom",
        position: { x: 0, y: 100 },
        data: {
          type: "action",
          label: "Bad Action",
          config: { actionType: "NonExistentAction" },
        },
      };

      await db.insert(workflows).values({
        id: workflowId,
        name: "Failing Workflow",
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        nodes: [triggerNode, badNode],
        edges: [{ id: "e1", source: "trigger_1", target: "bad_1" }],
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

      // Create execution
      await db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        userId: TEST_USER_ID,
        status: "pending",
        input: { triggerType: "schedule", scheduleId },
        startedAt: new Date(),
      });

      // Run workflow-runner (should fail but record to DB)
      const result = await runWorkflowRunner(workflowId, executionId, {
        scheduleId,
        timeout: 30_000,
      });

      // Per KEEP-1228: Exit 0 when workflow fails but result is recorded to DB
      // Exit 1 is only for system errors (DB unreachable, signal termination)
      expect(result.exitCode).toBe(0);

      // Poll for schedule status update (may take a moment for DB write to be visible)
      let updatedSchedule: (typeof workflowSchedules.$inferSelect)[] = [];
      for (let i = 0; i < 10; i++) {
        updatedSchedule = await db
          .select()
          .from(workflowSchedules)
          .where(eq(workflowSchedules.id, scheduleId))
          .limit(1);

        if (updatedSchedule[0]?.lastStatus === "error") {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(updatedSchedule[0]?.lastStatus).toBe("error");
      expect(updatedSchedule[0]?.lastError).toBeDefined();
    }, 60_000);

    it("should handle disabled schedule gracefully", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}schedule_disabled`;
      const scheduleId = `${TEST_SCHEDULE_PREFIX}schedule_disabled`;

      // Create workflow
      await createCheckBalanceWorkflow(workflowId);

      // Create disabled schedule
      await db.insert(workflowSchedules).values({
        id: scheduleId,
        workflowId,
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: false, // Disabled
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Simulate dispatcher message (shouldn't happen for disabled schedules, but test robustness)
      const message: ScheduleMessage = {
        workflowId,
        scheduleId,
        triggerTime: new Date().toISOString(),
        triggerType: "schedule",
      };

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: testQueueUrl,
          MessageBody: JSON.stringify(message),
        })
      );

      // Receive and verify
      const receiveResult = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: testQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 5,
        })
      );

      expect(receiveResult.Messages?.length).toBeGreaterThan(0);

      // In real job-spawner, it would check schedule.enabled and skip
      const schedule = await db
        .select()
        .from(workflowSchedules)
        .where(eq(workflowSchedules.id, scheduleId))
        .limit(1);

      expect(schedule[0]?.enabled).toBe(false);

      // Clean up
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: testQueueUrl,
          ReceiptHandle: receiveResult.Messages?.[0].ReceiptHandle,
        })
      );
    }, 30_000);
  });

  describe("Disabled Workflow Handling (KEEP-1253)", () => {
    const PIPELINE_TIMEOUT = 90_000;

    /**
     * Helper to create a workflow with enabled flag
     */
    async function createWorkflowWithEnabledFlag(
      id: string,
      enabled: boolean
    ): Promise<string> {
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
        id: "check_balance_1",
        type: "custom",
        position: { x: 0, y: 150 },
        data: {
          type: "action",
          label: "Check Balance",
          config: {
            actionType: "Check Balance",
            network: "sepolia",
            address: TEST_ADDRESS,
          },
        },
      };

      await db.insert(workflows).values({
        id,
        name: `Test Workflow ${id}`,
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        nodes: [triggerNode, checkBalanceNode],
        edges: [{ id: "e1", source: "trigger_1", target: "check_balance_1" }],
        visibility: "private",
        enabled, // Set the enabled flag
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return id;
    }

    it("should skip execution for disabled workflow (job-spawner check)", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}disabled_wf_check`;
      const scheduleId = `${TEST_SCHEDULE_PREFIX}disabled_wf_check`;

      // Step 1: Create disabled workflow
      await createWorkflowWithEnabledFlag(workflowId, false);

      // Step 2: Create enabled schedule (the workflow is what's disabled)
      await db.insert(workflowSchedules).values({
        id: scheduleId,
        workflowId,
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true, // Schedule is enabled
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Verify workflow is disabled in DB
      const workflow = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .limit(1);

      expect(workflow[0]?.enabled).toBe(false);

      // Verify schedule is enabled
      const schedule = await db
        .select()
        .from(workflowSchedules)
        .where(eq(workflowSchedules.id, scheduleId))
        .limit(1);

      expect(schedule[0]?.enabled).toBe(true);

      // Step 3: Simulate dispatcher message (dispatcher should also check workflow.enabled)
      const message: ScheduleMessage = {
        workflowId,
        scheduleId,
        triggerTime: new Date().toISOString(),
        triggerType: "schedule",
      };

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: testQueueUrl,
          MessageBody: JSON.stringify(message),
        })
      );

      // Step 4: Receive and verify - job-spawner would check workflow.enabled here
      const receiveResult = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: testQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 5,
        })
      );

      expect(receiveResult.Messages?.length).toBeGreaterThan(0);

      // In the real job-spawner, it would query the workflow and skip if disabled
      // This test verifies the data is set up correctly for that check
      const workflowCheck = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .limit(1);

      expect(workflowCheck[0]?.enabled).toBe(false);

      // Clean up
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: testQueueUrl,
          ReceiptHandle: receiveResult.Messages?.[0].ReceiptHandle,
        })
      );
    }, 30_000);

    it(
      "should handle race condition: workflow disabled after dispatch but before execution",
      async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}race_disabled`;
        const scheduleId = `${TEST_SCHEDULE_PREFIX}race_disabled`;
        const executionId = `${TEST_EXECUTION_PREFIX}race_disabled`;

        // Step 1: Create enabled workflow (simulate it was enabled when dispatched)
        await createWorkflowWithEnabledFlag(workflowId, true);

        // Step 2: Create schedule
        await db.insert(workflowSchedules).values({
          id: scheduleId,
          workflowId,
          cronExpression: "* * * * *",
          timezone: "UTC",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Step 3: Message was sent to SQS (dispatcher sent it while workflow was enabled)
        const message: ScheduleMessage = {
          workflowId,
          scheduleId,
          triggerTime: new Date().toISOString(),
          triggerType: "schedule",
        };

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: testQueueUrl,
            MessageBody: JSON.stringify(message),
          })
        );

        // Step 4: Receive message
        const receiveResult = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: testQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
          })
        );

        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: testQueueUrl,
            ReceiptHandle: receiveResult.Messages?.[0].ReceiptHandle,
          })
        );

        // Step 5: RACE CONDITION - User disables workflow AFTER dispatch but BEFORE execution
        await db
          .update(workflows)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(workflows.id, workflowId));

        // Verify workflow is now disabled
        const disabledWorkflow = await db
          .select()
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .limit(1);

        expect(disabledWorkflow[0]?.enabled).toBe(false);

        // Step 6: Create execution record (job-spawner creates this before K8s job)
        await db.insert(workflowExecutions).values({
          id: executionId,
          workflowId,
          userId: TEST_USER_ID,
          status: "pending",
          input: { triggerType: "schedule", scheduleId },
          startedAt: new Date(),
        });

        // Step 7: Run workflow-runner - it should detect the disabled workflow
        // and cancel the execution (defense in depth check)
        const result = await runWorkflowRunner(workflowId, executionId, {
          scheduleId,
          timeout: PIPELINE_TIMEOUT,
        });

        // Runner should exit cleanly (0) after detecting disabled workflow
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          "Workflow not executable (disabled), skipping execution"
        );

        // Verify the execution was marked as cancelled
        const execution = await db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        expect(execution[0]?.status).toBe("cancelled");
      },
      PIPELINE_TIMEOUT
    );

    it(
      "should allow execution for enabled workflow",
      async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}enabled_wf`;
        const executionId = `${TEST_EXECUTION_PREFIX}enabled_wf`;

        // Create enabled workflow
        await createWorkflowWithEnabledFlag(workflowId, true);

        // Verify it's enabled
        const workflow = await db
          .select()
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .limit(1);

        expect(workflow[0]?.enabled).toBe(true);

        // Create execution
        await db.insert(workflowExecutions).values({
          id: executionId,
          workflowId,
          userId: TEST_USER_ID,
          status: "pending",
          input: { triggerType: "manual" },
          startedAt: new Date(),
        });

        // Run workflow - should succeed
        const result = await runWorkflowRunner(workflowId, executionId, {
          timeout: PIPELINE_TIMEOUT,
        });

        expect(result.exitCode).toBe(0);

        const execution = await db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        expect(execution[0]?.status).toBe("success");
      },
      PIPELINE_TIMEOUT
    );
  });

  describe("SQS Message Flow Verification", () => {
    it("should maintain message attributes through the queue", async () => {
      const workflowId = `${TEST_WORKFLOW_PREFIX}msg_attrs`;
      const scheduleId = `${TEST_SCHEDULE_PREFIX}msg_attrs`;

      const message: ScheduleMessage = {
        workflowId,
        scheduleId,
        triggerTime: new Date().toISOString(),
        triggerType: "schedule",
      };

      // Send with attributes
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: testQueueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            TriggerType: {
              DataType: "String",
              StringValue: "schedule",
            },
            WorkflowId: {
              DataType: "String",
              StringValue: workflowId,
            },
            ScheduleId: {
              DataType: "String",
              StringValue: scheduleId,
            },
          },
        })
      );

      // Receive with attributes
      const receiveResult = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: testQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 5,
          MessageAttributeNames: ["All"],
        })
      );

      const msg = receiveResult.Messages?.[0];
      expect(msg?.MessageAttributes?.TriggerType?.StringValue).toBe("schedule");
      expect(msg?.MessageAttributes?.WorkflowId?.StringValue).toBe(workflowId);
      expect(msg?.MessageAttributes?.ScheduleId?.StringValue).toBe(scheduleId);

      // Clean up
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: testQueueUrl,
          ReceiptHandle: msg?.ReceiptHandle,
        })
      );
    });

    it("should handle multiple messages in queue", async () => {
      const messageCount = 5;
      const messages: ScheduleMessage[] = [];

      // Send multiple messages
      for (let i = 0; i < messageCount; i++) {
        const msg: ScheduleMessage = {
          workflowId: `${TEST_WORKFLOW_PREFIX}batch_${i}`,
          scheduleId: `${TEST_SCHEDULE_PREFIX}batch_${i}`,
          triggerTime: new Date().toISOString(),
          triggerType: "schedule",
        };
        messages.push(msg);

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: testQueueUrl,
            MessageBody: JSON.stringify(msg),
          })
        );
      }

      // Receive all messages
      const receiveResult = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: testQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 5,
        })
      );

      expect(receiveResult.Messages?.length).toBe(messageCount);

      // Clean up
      for (const msg of receiveResult.Messages || []) {
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: testQueueUrl,
            ReceiptHandle: msg.ReceiptHandle,
          })
        );
      }
    });
  });
});
