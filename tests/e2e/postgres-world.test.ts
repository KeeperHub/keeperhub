/**
 * E2E Tests for Workflow Postgres World
 *
 * Verifies that the @workflow/world-postgres integration works:
 * 1. workflow-postgres-setup creates the workflow schema tables
 * 2. world.start() creates pg-boss schema tables
 * 3. Workflow executions flow through pg-boss and persist in workflow.workflow_runs
 * 4. Steps are recorded in workflow.workflow_steps
 *
 * Prerequisites:
 * - Docker compose dev profile running with WORKFLOW_TARGET_WORLD=@workflow/world-postgres
 * - WORKFLOW_POSTGRES_URL or DATABASE_URL pointing to the database
 * - workflow-postgres-setup already run against the database
 * - App running at KEEPERHUB_URL (default: http://localhost:3000)
 *
 * Run with: pnpm vitest tests/e2e/postgres-world.test.ts
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users, workflowExecutions, workflows } from "@/lib/db/schema";
import { PERSISTENT_TEST_USER_EMAIL } from "../utils/db";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/keeperhub";

const KEEPERHUB_URL = process.env.KEEPERHUB_URL || "http://localhost:3000";
const SERVICE_KEY =
  process.env.SCHEDULER_SERVICE_API_KEY || "local-scheduler-key-for-dev";

// Requires workflow + pgboss schemas. Run `pnpm db:setup-workflow` to create them.
const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

function generateId(): string {
  return crypto.randomBytes(11).toString("base64url");
}

async function checkPgbossSchema(): Promise<boolean> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    const result = await client`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'
    `;
    return result.length > 0;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

async function poll<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  intervalMs: number,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (predicate(result)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Polling timed out after ${timeoutMs}ms`);
}

// Also skip if pgboss schema hasn't been created (requires pnpm db:setup-workflow)
const hasPgboss = shouldSkip ? false : await checkPgbossSchema();

describe.skipIf(shouldSkip || !hasPgboss)("Postgres World E2E", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testUserId: string;
  let testWorkflowId: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(client);

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
    testUserId = existingUser[0].id;

    testWorkflowId = generateId();
    const nodes = [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 100 },
        data: { label: "Manual Trigger" },
      },
    ];

    await db.insert(workflows).values({
      id: testWorkflowId,
      name: "Postgres World E2E Test",
      userId: testUserId,
      nodes,
      edges: [],
    });
  });

  afterAll(async () => {
    if (testWorkflowId) {
      await db
        .delete(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, testWorkflowId));
      await db.delete(workflows).where(eq(workflows.id, testWorkflowId));
    }
    await client.end();
  });

  describe("Schema Setup", () => {
    it("should have workflow schema tables from workflow-postgres-setup", async () => {
      const result = await client<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'workflow'
        ORDER BY table_name
      `;

      const tables = result.map((row) => row.table_name);

      expect(tables).toContain("workflow_runs");
      expect(tables).toContain("workflow_steps");
      expect(tables).toContain("workflow_events");
      expect(tables).toContain("workflow_hooks");
      expect(tables).toContain("workflow_stream_chunks");
    });

    it("should have pgboss schema tables from world.start()", async () => {
      const result = await client<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'pgboss'
        ORDER BY table_name
      `;

      const tables = result.map((row) => row.table_name);

      expect(tables).toContain("job");
      expect(tables).toContain("queue");
      expect(tables).toContain("version");
    });

    it("should have workflow_drizzle migration tracking schema", async () => {
      const result = await client`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'workflow_drizzle'
      `;

      expect(result.length).toBeGreaterThan(0);
    });
  });

  // These tests require the app running at KEEPERHUB_URL connected to the same database.
  // Set KEEPERHUB_URL explicitly (not the default fallback) to enable them.
  describe.skipIf(!process.env.RUN_APP_TESTS)(
    "Workflow Execution via Postgres World",
    () => {
      it("should execute a workflow and persist run in workflow schema", {
        timeout: 35_000,
      }, async () => {
        const response = await fetch(
          `${KEEPERHUB_URL}/api/workflow/${testWorkflowId}/execute`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Service-Key": SERVICE_KEY,
            },
            body: JSON.stringify({ input: {} }),
          }
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          executionId: string;
          status: string;
        };
        expect(body.executionId).toBeDefined();
        expect(body.status).toBe("running");

        // Poll workflow.workflow_runs until the run reaches a terminal state
        type RunRow = {
          id: string;
          status: string;
          completed_at: string | null;
        };
        const run = await poll(
          async (): Promise<RunRow | null> => {
            const rows = await client<RunRow[]>`
              SELECT id, status, completed_at
              FROM workflow.workflow_runs
              ORDER BY created_at DESC
              LIMIT 1
            `;
            return rows[0] ?? null;
          },
          (row): row is RunRow =>
            row !== null &&
            (row.status === "completed" || row.status === "failed"),
          500,
          30_000
        );

        if (!run) {
          throw new Error("Expected workflow run to exist");
        }
        expect(run.status).toBe("completed");
        expect(run.completed_at).not.toBeNull();
      });

      it("should record steps in workflow.workflow_steps", {
        timeout: 35_000,
      }, async () => {
        const response = await fetch(
          `${KEEPERHUB_URL}/api/workflow/${testWorkflowId}/execute`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Service-Key": SERVICE_KEY,
            },
            body: JSON.stringify({ input: {} }),
          }
        );

        expect(response.status).toBe(200);

        // Poll until steps appear for the latest run
        type StepRow = { step_name: string; status: string };
        const steps = await poll(
          async () => {
            const rows = await client<StepRow[]>`
              SELECT ws.step_name, ws.status
              FROM workflow.workflow_steps ws
              JOIN workflow.workflow_runs wr ON ws.run_id = wr.id
              WHERE wr.status IN ('completed', 'failed')
              ORDER BY wr.created_at DESC, ws.created_at ASC
              LIMIT 10
            `;
            return [...rows];
          },
          (rows) => rows.length > 0,
          500,
          30_000
        );

        expect(steps.length).toBeGreaterThan(0);

        for (const step of steps) {
          expect(step.status).toBe("completed");
        }
      });

      it("should process jobs through pg-boss", {
        timeout: 10_000,
      }, async () => {
        type JobStateRow = { state: string; count: number };
        const result = await client<JobStateRow[]>`
        SELECT state, count(*)::int as count
        FROM pgboss.job
        GROUP BY state
      `;

        const states = new Map(result.map((row) => [row.state, row.count]));

        // There should be completed jobs from the executions above
        expect(states.get("completed")).toBeGreaterThan(0);
      });
    }
  );
});
