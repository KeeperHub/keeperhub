/**
 * Shared database utilities for E2E testing
 *
 * These utilities can be used by both:
 * - Vitest E2E tests (tests/e2e/*.test.ts)
 * - Playwright tests (tests/e2e/playwright/*.test.ts)
 *
 * They provide database operations for test setup/teardown:
 * - Creating test workflows with properly connected nodes
 * - Creating API keys for webhook authentication
 * - Waiting for workflow executions to complete
 * - Cleanup functions
 */

import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import type {
  WorkflowEdgeJson,
  WorkflowNodeJson,
} from "@/lib/workflow/node-builders";
import {
  createManualWorkflow,
  createScheduledWorkflow,
  createWebhookWorkflow,
} from "../fixtures/workflows";

// ============================================================================
// Persistent test account constants (seeded by scripts/seed/seed-test-wallet.ts)
// ============================================================================

export const PERSISTENT_TEST_USER_EMAIL =
  "pr-test-do-not-delete@techops.services";
export const PERSISTENT_TEST_ORG_SLUG = "e2e-test-org";

/**
 * Look up the persistent test user seeded by `pnpm db:seed-test-wallet`.
 * Throws if the user does not exist.
 */
export async function getPersistentTestUserId(): Promise<string> {
  const sql = getDbConnection();
  try {
    const result = await sql`
      SELECT id FROM users WHERE email = ${PERSISTENT_TEST_USER_EMAIL}
    `;
    if (result.length === 0) {
      throw new Error(
        `Persistent test user "${PERSISTENT_TEST_USER_EMAIL}" not found. Run pnpm db:seed-test-wallet first.`
      );
    }
    return result[0].id as string;
  } finally {
    await sql.end();
  }
}

// ============================================================================
// Types
// ============================================================================

export type WorkflowTriggerType = "webhook" | "schedule" | "manual";

export type CreateTestWorkflowOptions = {
  name?: string;
  description?: string;
  enabled?: boolean;
  triggerType?: WorkflowTriggerType;
  cronExpression?: string;
  timezone?: string;
  actionEndpoint?: string;
  /**
   * Inject programmatically built workflow nodes/edges verbatim, bypassing the
   * synthetic-workflow branch. When both `nodes` and `edges` are provided, the
   * caller's shape is used as-is. KEEP-458: the protocol-coverage runner
   * passes builder output from `lib/test-data/build-workflow.ts` here.
   */
  nodes?: WorkflowNodeJson[];
  edges?: WorkflowEdgeJson[];
};

export type TestWorkflow = {
  id: string;
  name: string;
  userId: string;
  organizationId: string | null;
};

export type ExecutionResult = {
  status:
    | "success"
    | "error"
    | "pending"
    | "running"
    | "cancelled"
    | "system_error";
  executionId: string;
  error?: string;
};

// ============================================================================
// Internal helpers
// ============================================================================

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getDbConnection(): ReturnType<typeof postgres> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return postgres(databaseUrl, { max: 1 });
}

// ============================================================================
// User queries
// ============================================================================

/**
 * Get user ID from email
 */
export async function getUserIdByEmail(email: string): Promise<string | null> {
  const sql = getDbConnection();
  try {
    const result = await sql`
      SELECT id FROM users WHERE email = ${email}
    `;
    return result.length > 0 ? (result[0].id as string) : null;
  } finally {
    await sql.end();
  }
}

/**
 * Get user's organization ID
 */
export async function getUserOrganizationId(
  userId: string
): Promise<string | null> {
  const sql = getDbConnection();
  try {
    const result = await sql`
      SELECT organization_id FROM member WHERE user_id = ${userId} LIMIT 1
    `;
    return result.length > 0 ? (result[0].organization_id as string) : null;
  } finally {
    await sql.end();
  }
}

// ============================================================================
// Workflow operations
// ============================================================================

/**
 * Create a test workflow directly in the database with properly connected nodes
 */
export async function createTestWorkflow(
  userEmail: string,
  options: CreateTestWorkflowOptions = {}
): Promise<TestWorkflow> {
  const sql = getDbConnection();

  try {
    // Get user ID
    const userResult = await sql`
      SELECT id FROM users WHERE email = ${userEmail}
    `;
    if (userResult.length === 0) {
      throw new Error(`User not found with email: ${userEmail}`);
    }
    const userId = userResult[0].id as string;

    // Get organization ID. The org owns workflows (organization_id is NOT
    // NULL), so a test user without a membership is a fixture bug - fail
    // loudly here instead of with a constraint violation at insert.
    //
    // Deterministic pick: prefer the user's owned org, oldest first. A shared
    // persistent test user can accrue extra memberships during a suite run
    // (e.g. accepting an invite to a second org). An unordered LIMIT 1 then
    // picks an arbitrary org, which can diverge from the org the browser
    // session is acting in (its active org is fixed at login). The workflow
    // would land in the wrong org and every later access check (getWorkflowAccess)
    // would 404. Ordering by owner-then-oldest stably resolves to the seeded
    // primary org, matching the session.
    const orgResult = await sql`
      SELECT organization_id FROM member
      WHERE user_id = ${userId}
      ORDER BY (role = 'owner') DESC, created_at ASC
      LIMIT 1
    `;
    if (orgResult.length === 0) {
      throw new Error(
        `Test user ${userEmail} has no organization membership; every workflow needs an owning org`
      );
    }
    const organizationId = orgResult[0].organization_id as string;

    const {
      name = `Test Workflow ${Date.now()}`,
      description = "Test workflow created via database injection",
      enabled = true,
      triggerType = "webhook",
      cronExpression = "0 9 * * *",
      timezone = "UTC",
      actionEndpoint,
      nodes: fixtureNodes,
      edges: fixtureEdges,
    } = options;

    // KEEP-458: when caller supplies a fixture's nodes/edges, insert them
    // verbatim and skip the synthetic-workflow branch.
    let workflow: { nodes: unknown[]; edges: unknown[] };
    if (fixtureNodes && fixtureEdges) {
      workflow = { nodes: fixtureNodes, edges: fixtureEdges };
    } else if (triggerType === "schedule") {
      workflow = createScheduledWorkflow(cronExpression, timezone);
    } else if (triggerType === "manual") {
      workflow = createManualWorkflow(actionEndpoint);
    } else {
      workflow = createWebhookWorkflow();
    }

    const workflowId = generateId();
    const now = new Date();
    const isAnonymous = !organizationId;

    // Insert workflow with JSONB casting for nodes and edges
    const nodesStr = JSON.stringify(workflow.nodes);
    const edgesStr = JSON.stringify(workflow.edges);

    await sql.unsafe(
      `INSERT INTO workflows (
        id, name, description, user_id, organization_id, is_anonymous,
        nodes, edges, visibility, enabled, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'private', $9, $10, $11
      )`,
      [
        workflowId,
        name,
        description,
        userId,
        organizationId,
        isAnonymous,
        nodesStr,
        edgesStr,
        enabled,
        now,
        now,
      ]
    );

    // If schedule trigger, also create the schedule record
    if (triggerType === "schedule") {
      const scheduleId = generateId();
      await sql`
        INSERT INTO workflow_schedules (
          id, workflow_id, cron_expression, timezone, enabled, created_at, updated_at
        ) VALUES (
          ${scheduleId},
          ${workflowId},
          ${cronExpression},
          ${timezone},
          ${enabled},
          ${now},
          ${now}
        )
      `;
    }

    return {
      id: workflowId,
      name,
      userId,
      organizationId,
    };
  } finally {
    await sql.end();
  }
}

/**
 * Delete a test workflow from the database
 */
export async function deleteTestWorkflow(workflowId: string): Promise<void> {
  const sql = getDbConnection();
  try {
    // Delete execution logs first (foreign key constraint)
    await sql`
      DELETE FROM workflow_execution_logs
      WHERE execution_id IN (
        SELECT id FROM workflow_executions WHERE workflow_id = ${workflowId}
      )
    `;

    // Delete executions
    await sql`
      DELETE FROM workflow_executions WHERE workflow_id = ${workflowId}
    `;

    // Delete schedule if exists
    await sql`
      DELETE FROM workflow_schedules WHERE workflow_id = ${workflowId}
    `;

    // Delete workflow
    await sql`
      DELETE FROM workflows WHERE id = ${workflowId}
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Get the webhook URL for a workflow
 */
export function getWorkflowWebhookUrl(
  workflowId: string,
  baseUrl = "http://localhost:3000"
): string {
  return `${baseUrl}/api/workflows/${workflowId}/webhook`;
}

/**
 * Wait for workflow execution to complete
 */
export async function waitForWorkflowExecution(
  workflowId: string,
  timeoutMs = 60_000
): Promise<ExecutionResult | null> {
  const startTime = Date.now();
  const pollInterval = 1000;
  const sql = getDbConnection();

  try {
    while (Date.now() - startTime < timeoutMs) {
      const result = await sql`
        SELECT id, status, error FROM workflow_executions
        WHERE workflow_id = ${workflowId}
        ORDER BY started_at DESC
        LIMIT 1
      `;

      if (result.length > 0) {
        const execution = result[0];
        const status = execution.status as string;

        // cancelled and system_error are terminal too; treating them as
        // non-terminal burns the full timeout before any diagnosis runs.
        if (
          status === "success" ||
          status === "error" ||
          status === "cancelled" ||
          status === "system_error"
        ) {
          return {
            status: status as ExecutionResult["status"],
            executionId: execution.id as string,
            error: execution.error as string | undefined,
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return null;
  } finally {
    await sql.end();
  }
}

// ============================================================================
// API Key operations
// ============================================================================

/**
 * Create an API key for a user (required for webhook authentication)
 */
export async function createApiKey(userEmail: string): Promise<string> {
  const sql = getDbConnection();

  try {
    // Get user ID
    const userResult = await sql`
      SELECT id FROM users WHERE email = ${userEmail}
    `;
    if (userResult.length === 0) {
      throw new Error(`User not found with email: ${userEmail}`);
    }
    const userId = userResult[0].id as string;

    // Generate API key
    const keyId = generateId();
    const rawKey = `wfb_${randomBytes(16).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 12);
    const now = new Date();

    // Insert API key
    await sql`
      INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at)
      VALUES (${keyId}, ${userId}, 'Test API Key', ${keyHash}, ${keyPrefix}, ${now})
    `;

    return rawKey;
  } finally {
    await sql.end();
  }
}

/**
 * Delete an API key
 */
export async function deleteApiKey(apiKey: string): Promise<void> {
  const sql = getDbConnection();
  try {
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    await sql`DELETE FROM api_keys WHERE key_hash = ${keyHash}`;
  } finally {
    await sql.end();
  }
}
