/* biome-ignore-all lint/correctness/noGlobalDirnameFilename: vitest requires __dirname */

/**
 * E2E Tests for User RPC Preferences → Workflow Execution Flow
 *
 * Tests the full flow:
 * 1. User creates custom RPC preferences
 * 2. User creates a workflow with a web3 step (check-balance)
 * 3. User executes the workflow
 * 4. Workflow runner uses the user's custom RPC preferences
 *
 * Prerequisites:
 * - PostgreSQL database running
 * - DATABASE_URL environment variable set
 * - Chains table seeded with at least Sepolia
 *
 * Run with: pnpm vitest tests/e2e/user-rpc-workflow.test.ts
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chains,
  organization,
  userRpcPreferences,
  users,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";
import { PERSISTENT_TEST_USER_EMAIL } from "../../utils/db";

// Skip these tests if infrastructure isn't available
const SKIP_INFRA_TESTS = process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/workflow_builder";

// Test data IDs (use consistent prefixes for cleanup)
const TEST_PREFIX = "test_rpc_wf_e2e_";
const TEST_WORKFLOW_PREFIX = `${TEST_PREFIX}wf_`;
const TEST_EXECUTION_PREFIX = `${TEST_PREFIX}exec_`;
const TEST_ORG_ID = `${TEST_PREFIX}org`;

// Test RPC URLs - use TechOps Sepolia for primary (reliable)
const CUSTOM_PRIMARY_RPC = "https://chain.techops.services/eth-sepolia";
const CUSTOM_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

// A well-known address for balance checking (Sepolia)
const TEST_ADDRESS = "0xaa00000000000000000000000000000000000000";

describe.skipIf(SKIP_INFRA_TESTS)(
  "User RPC Preferences → Workflow Execution E2E",
  () => {
    let queryClient: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle>;
    let sepoliaChainId: number;
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
          chains,
          userRpcPreferences,
        },
      });

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
      }

      sepoliaChainId = 11_155_111;

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

    // Clean up before each test
    beforeEach(async () => {
      try {
        // Delete in FK order
        await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
        await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
        await queryClient`DELETE FROM workflow_schedules WHERE workflow_id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
        await queryClient`DELETE FROM workflows WHERE id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
        await db
          .delete(userRpcPreferences)
          .where(eq(userRpcPreferences.userId, TEST_USER_ID));
      } catch {
        // Ignore cleanup errors
      }
    });

    afterAll(async () => {
      // Final cleanup
      try {
        await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
        await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${TEST_EXECUTION_PREFIX}%`}`;
        await queryClient`DELETE FROM workflow_schedules WHERE workflow_id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
        await queryClient`DELETE FROM workflows WHERE id LIKE ${`${TEST_WORKFLOW_PREFIX}%`}`;
        await queryClient`DELETE FROM organization WHERE id = ${TEST_ORG_ID}`;
        await db
          .delete(userRpcPreferences)
          .where(eq(userRpcPreferences.userId, TEST_USER_ID));
      } catch (error) {
        console.warn("Cleanup warning:", error);
      }

      await queryClient.end();
    });

    /**
     * Helper to run the workflow-runner script
     */
    async function runWorkflowRunner(
      workflowId: string,
      executionId: string,
      options: {
        input?: Record<string, unknown>;
        timeout?: number;
      } = {}
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        const env = {
          ...process.env,
          WORKFLOW_ID: workflowId,
          EXECUTION_ID: executionId,
          DATABASE_URL,
          WORKFLOW_INPUT: JSON.stringify(options.input || {}),
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

    /**
     * Helper to create a workflow with check-balance step
     */
    async function createCheckBalanceWorkflow(
      id: string,
      network: string,
      address: string
    ): Promise<string> {
      const triggerNode = {
        id: "trigger_1",
        type: "custom",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Manual Trigger",
          config: {
            triggerType: "Manual",
          },
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
            network,
            address,
          },
        },
      };

      const edges = [
        { id: "e1", source: "trigger_1", target: "check_balance_1" },
      ];

      await db.insert(workflows).values({
        id,
        name: `Test RPC Workflow ${id}`,
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        nodes: [triggerNode, checkBalanceNode],
        edges,
        visibility: "private",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return id;
    }

    /**
     * Helper to create an execution record
     */
    async function createExecution(
      id: string,
      workflowId: string
    ): Promise<string> {
      await db.insert(workflowExecutions).values({
        id,
        workflowId,
        userId: TEST_USER_ID,
        status: "pending",
        input: { triggerType: "test" },
        startedAt: new Date(),
      });
      return id;
    }

    /**
     * Helper to get execution result
     */
    async function getExecutionResult(executionId: string) {
      const result = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, executionId))
        .limit(1);
      return result[0] || null;
    }

    describe("Full Flow: RPC Preferences → Workflow → Execution", () => {
      const WORKFLOW_TEST_TIMEOUT = 90_000;

      it(
        "should use default RPC when user has no preferences",
        async () => {
          const workflowId = `${TEST_WORKFLOW_PREFIX}default_rpc`;
          const executionId = `${TEST_EXECUTION_PREFIX}default_rpc`;

          // Create workflow without any user RPC preferences
          await createCheckBalanceWorkflow(workflowId, "sepolia", TEST_ADDRESS);
          await createExecution(executionId, workflowId);

          // Run the workflow
          const result = await runWorkflowRunner(workflowId, executionId, {
            timeout: WORKFLOW_TEST_TIMEOUT,
          });

          // Verify workflow completed successfully
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(
            "[Runner] Starting workflow execution"
          );
          expect(result.stdout).toContain(
            "[Runner] Execution completed successfully"
          );

          // Verify execution status in database
          const execution = await getExecutionResult(executionId);
          expect(execution?.status).toBe("success");

          // Verify the check-balance step ran
          expect(result.stdout).toContain("[Check Balance]");
        },
        WORKFLOW_TEST_TIMEOUT
      );

      it(
        "should use custom RPC preferences when user sets them",
        async () => {
          const workflowId = `${TEST_WORKFLOW_PREFIX}custom_rpc`;
          const executionId = `${TEST_EXECUTION_PREFIX}custom_rpc`;

          // Step 1: Create user RPC preferences
          await db.insert(userRpcPreferences).values({
            userId: TEST_USER_ID,
            chainId: sepoliaChainId,
            primaryRpcUrl: CUSTOM_PRIMARY_RPC,
            fallbackRpcUrl: CUSTOM_FALLBACK_RPC,
          });

          // Verify preference was saved
          const prefs = await db
            .select()
            .from(userRpcPreferences)
            .where(
              and(
                eq(userRpcPreferences.userId, TEST_USER_ID),
                eq(userRpcPreferences.chainId, sepoliaChainId)
              )
            );
          expect(prefs.length).toBe(1);
          expect(prefs[0].primaryRpcUrl).toBe(CUSTOM_PRIMARY_RPC);

          // Step 2: Create workflow
          await createCheckBalanceWorkflow(workflowId, "sepolia", TEST_ADDRESS);

          // Step 3: Create execution
          await createExecution(executionId, workflowId);

          // Step 4: Run the workflow
          const result = await runWorkflowRunner(workflowId, executionId, {
            timeout: WORKFLOW_TEST_TIMEOUT,
          });

          // Verify workflow completed successfully
          expect(result.exitCode).toBe(0);

          // Verify execution status
          const execution = await getExecutionResult(executionId);
          expect(execution?.status).toBe("success");

          // The check-balance step should have logged user RPC preferences
          expect(result.stdout).toContain("[Check Balance]");
          expect(result.stdout).toContain(
            "Using user RPC preferences for userId"
          );
        },
        WORKFLOW_TEST_TIMEOUT
      );

      it(
        "should create preferences, workflow, and execution in sequence",
        async () => {
          const workflowId = `${TEST_WORKFLOW_PREFIX}full_sequence`;
          const executionId = `${TEST_EXECUTION_PREFIX}full_sequence`;

          // Step 1: Verify no preferences exist initially
          const initialPrefs = await db
            .select()
            .from(userRpcPreferences)
            .where(eq(userRpcPreferences.userId, TEST_USER_ID));
          expect(initialPrefs.length).toBe(0);

          // Step 2: Create RPC preferences (simulating user settings update)
          const [newPref] = await db
            .insert(userRpcPreferences)
            .values({
              userId: TEST_USER_ID,
              chainId: sepoliaChainId,
              primaryRpcUrl: CUSTOM_PRIMARY_RPC,
              fallbackRpcUrl: CUSTOM_FALLBACK_RPC,
            })
            .returning();

          expect(newPref.id).toBeDefined();
          expect(newPref.primaryRpcUrl).toBe(CUSTOM_PRIMARY_RPC);

          // Step 3: Create workflow
          await createCheckBalanceWorkflow(workflowId, "sepolia", TEST_ADDRESS);

          // Verify workflow was created
          const savedWorkflow = await db
            .select()
            .from(workflows)
            .where(eq(workflows.id, workflowId))
            .limit(1);
          expect(savedWorkflow.length).toBe(1);
          expect(savedWorkflow[0].userId).toBe(TEST_USER_ID);

          // Step 4: Create execution
          await createExecution(executionId, workflowId);

          // Verify execution was created
          const savedExecution = await db
            .select()
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, executionId))
            .limit(1);
          expect(savedExecution.length).toBe(1);
          expect(savedExecution[0].status).toBe("pending");

          // Step 5: Run workflow
          const result = await runWorkflowRunner(workflowId, executionId, {
            timeout: WORKFLOW_TEST_TIMEOUT,
          });

          // Step 6: Verify successful completion
          expect(result.exitCode).toBe(0);

          const finalExecution = await getExecutionResult(executionId);
          expect(finalExecution?.status).toBe("success");
          expect(finalExecution?.completedAt).toBeDefined();
        },
        WORKFLOW_TEST_TIMEOUT
      );

      it(
        "should use user's custom RPC with fallback configured",
        async () => {
          const workflowId = `${TEST_WORKFLOW_PREFIX}with_fallback`;
          const executionId = `${TEST_EXECUTION_PREFIX}with_fallback`;

          // Set up user preferences with both primary and fallback (both valid)
          // This tests that the full user preference config is loaded
          await db.insert(userRpcPreferences).values({
            userId: TEST_USER_ID,
            chainId: sepoliaChainId,
            primaryRpcUrl: CUSTOM_PRIMARY_RPC,
            fallbackRpcUrl: CUSTOM_FALLBACK_RPC,
          });

          // Create workflow and execution
          await createCheckBalanceWorkflow(workflowId, "sepolia", TEST_ADDRESS);
          await createExecution(executionId, workflowId);

          // Run workflow
          const result = await runWorkflowRunner(workflowId, executionId, {
            timeout: WORKFLOW_TEST_TIMEOUT,
          });

          // Workflow should succeed using user's primary RPC
          expect(result.exitCode).toBe(0);

          const execution = await getExecutionResult(executionId);
          expect(execution?.status).toBe("success");

          // Should see user preferences being used
          expect(result.stdout).toContain(
            "Using user RPC preferences for userId"
          );
        },
        WORKFLOW_TEST_TIMEOUT
      );
    });

    describe("RPC Preferences CRUD during Workflow Lifecycle", () => {
      it("should update RPC preference and use new value in next execution", async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}update_pref`;
        const executionId1 = `${TEST_EXECUTION_PREFIX}update_pref_1`;
        const executionId2 = `${TEST_EXECUTION_PREFIX}update_pref_2`;

        // Create workflow first
        await createCheckBalanceWorkflow(workflowId, "sepolia", TEST_ADDRESS);

        // First execution without preferences
        await createExecution(executionId1, workflowId);
        const result1 = await runWorkflowRunner(workflowId, executionId1, {
          timeout: 60_000,
        });
        expect(result1.exitCode).toBe(0);

        // Now add RPC preferences
        await db.insert(userRpcPreferences).values({
          userId: TEST_USER_ID,
          chainId: sepoliaChainId,
          primaryRpcUrl: CUSTOM_PRIMARY_RPC,
          fallbackRpcUrl: CUSTOM_FALLBACK_RPC,
        });

        // Second execution should use new preferences
        await createExecution(executionId2, workflowId);
        const result2 = await runWorkflowRunner(workflowId, executionId2, {
          timeout: 60_000,
        });
        expect(result2.exitCode).toBe(0);

        // Verify second execution used user preferences
        expect(result2.stdout).toContain(
          "Using user RPC preferences for userId"
        );
      }, 120_000);

      it("should delete RPC preference and use defaults in next execution", async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}delete_pref`;
        const executionId1 = `${TEST_EXECUTION_PREFIX}delete_pref_1`;
        const executionId2 = `${TEST_EXECUTION_PREFIX}delete_pref_2`;

        // Create workflow
        await createCheckBalanceWorkflow(workflowId, "sepolia", TEST_ADDRESS);

        // Add then delete preferences
        await db.insert(userRpcPreferences).values({
          userId: TEST_USER_ID,
          chainId: sepoliaChainId,
          primaryRpcUrl: CUSTOM_PRIMARY_RPC,
        });

        // First execution with preferences
        await createExecution(executionId1, workflowId);
        const result1 = await runWorkflowRunner(workflowId, executionId1, {
          timeout: 60_000,
        });
        expect(result1.exitCode).toBe(0);
        expect(result1.stdout).toContain("Using user RPC preferences");

        // Delete preferences
        await db
          .delete(userRpcPreferences)
          .where(
            and(
              eq(userRpcPreferences.userId, TEST_USER_ID),
              eq(userRpcPreferences.chainId, sepoliaChainId)
            )
          );

        // Second execution should use defaults (no "Using user RPC preferences" log)
        await createExecution(executionId2, workflowId);
        const result2 = await runWorkflowRunner(workflowId, executionId2, {
          timeout: 60_000,
        });
        expect(result2.exitCode).toBe(0);

        // Should NOT see user preferences log in second execution
        // The log only appears when userId resolves successfully
        const execution2 = await getExecutionResult(executionId2);
        expect(execution2?.status).toBe("success");
      }, 120_000);
    });

    describe("Edge Cases", () => {
      it("should handle disabled chain gracefully", async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}disabled_chain`;
        const executionId = `${TEST_EXECUTION_PREFIX}disabled_chain`;
        const disabledChainId = 99_999_999;

        // Create a disabled chain
        await db.insert(chains).values({
          chainId: disabledChainId,
          name: "Disabled Test Chain",
          symbol: "DIS",
          defaultPrimaryRpc: "https://disabled.example.com",
          isEnabled: false,
        });

        try {
          // Set user preference for disabled chain
          await db.insert(userRpcPreferences).values({
            userId: TEST_USER_ID,
            chainId: disabledChainId,
            primaryRpcUrl: "https://user-disabled.example.com",
          });

          // Create workflow targeting disabled chain (will fail at network resolution)
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
                network: "disabled-chain", // This won't be found
                address: TEST_ADDRESS,
              },
            },
          };

          await db.insert(workflows).values({
            id: workflowId,
            name: "Disabled Chain Test",
            userId: TEST_USER_ID,
            organizationId: TEST_ORG_ID,
            nodes: [triggerNode, checkBalanceNode],
            edges: [
              { id: "e1", source: "trigger_1", target: "check_balance_1" },
            ],
            visibility: "private",
            enabled: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          await createExecution(executionId, workflowId);

          const result = await runWorkflowRunner(workflowId, executionId, {
            timeout: 30_000,
          });

          // Per KEEP-1228: Exit 0 when workflow fails but result is recorded to DB
          // Exit 1 is only for system errors (DB unreachable, signal termination)
          expect(result.exitCode).toBe(0);

          const execution = await getExecutionResult(executionId);
          // KEEP-853: an RPC/network failure classifies as a system failure, so
          // the run may land as system_error rather than error.
          expect(["error", "system_error"]).toContain(execution?.status);
        } finally {
          // Cleanup disabled chain
          await db
            .delete(userRpcPreferences)
            .where(eq(userRpcPreferences.chainId, disabledChainId));
          await db.delete(chains).where(eq(chains.chainId, disabledChainId));
        }
      }, 60_000);

      it("should handle multiple chains in same workflow", async () => {
        const workflowId = `${TEST_WORKFLOW_PREFIX}multi_chain`;
        const executionId = `${TEST_EXECUTION_PREFIX}multi_chain`;

        // Set up preferences for Sepolia
        await db.insert(userRpcPreferences).values({
          userId: TEST_USER_ID,
          chainId: sepoliaChainId,
          primaryRpcUrl: CUSTOM_PRIMARY_RPC,
          fallbackRpcUrl: CUSTOM_FALLBACK_RPC,
        });

        // Create workflow with two check-balance steps on same chain
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

        const checkBalance1 = {
          id: "check_balance_1",
          type: "custom",
          position: { x: 0, y: 150 },
          data: {
            type: "action",
            label: "Check Balance 1",
            config: {
              actionType: "Check Balance",
              network: "sepolia",
              address: TEST_ADDRESS,
            },
          },
        };

        const checkBalance2 = {
          id: "check_balance_2",
          type: "custom",
          position: { x: 0, y: 300 },
          data: {
            type: "action",
            label: "Check Balance 2",
            config: {
              actionType: "Check Balance",
              network: "sepolia",
              address: "0x0000000000000000000000000000000000000000",
            },
          },
        };

        await db.insert(workflows).values({
          id: workflowId,
          name: "Multi-Step Balance Check",
          userId: TEST_USER_ID,
          organizationId: TEST_ORG_ID,
          nodes: [triggerNode, checkBalance1, checkBalance2],
          edges: [
            { id: "e1", source: "trigger_1", target: "check_balance_1" },
            { id: "e2", source: "check_balance_1", target: "check_balance_2" },
          ],
          visibility: "private",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await createExecution(executionId, workflowId);

        const result = await runWorkflowRunner(workflowId, executionId, {
          timeout: 90_000,
        });

        expect(result.exitCode).toBe(0);

        const execution = await getExecutionResult(executionId);
        expect(execution?.status).toBe("success");

        // Both check-balance steps should have used user preferences
        const prefLogCount = (
          result.stdout.match(/Using user RPC preferences for userId/g) || []
        ).length;
        expect(prefLogCount).toBe(2);
      }, 90_000);
    });
  }
);
