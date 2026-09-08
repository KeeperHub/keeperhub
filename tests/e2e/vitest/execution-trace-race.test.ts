/**
 * Integration tests for incrementCompletedSteps atomicity.
 *
 * These tests exercise real Postgres row-level behavior.  Mock harnesses
 * cannot reproduce the concurrent-write race; only a real DB can.
 *
 * Prerequisites:
 *   - Local Postgres running (DATABASE_URL set, or default localhost:5433)
 *   - Schema migrated: pnpm db:push
 *
 * Run with:
 *   pnpm test tests/e2e/vitest/execution-trace-race.test.ts
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---- module mocks --------------------------------------------------------
// server-only is a Next.js guard that throws outside SSR context.
// Bypass it so we can import the logging module in a Node test.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

// Build a real postgres connection at hoist time so it is available when
// vi.mock("@/lib/db") runs.  vi.hoisted executes before ESM imports are
// resolved, so we must use require() instead of the imported bindings.
const { realDb } = vi.hoisted(() => {
  const connectionString =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub";
  // CJS interop: require() is needed here because ESM imports are not yet
  // resolved when vi.hoisted runs.  The default export varies by bundler.
  // pgClient is typed as Sql<{}> at runtime; we cast through unknown to satisfy
  // drizzle's overloaded signature without pulling in postgres types at hoist time.
  const pgClientRaw: unknown = (
    require("postgres") as (url: string, opts: { max: number }) => unknown
  )(connectionString, { max: 20 });
  const { drizzle: drizzleFn } = require("drizzle-orm/postgres-js") as {
    drizzle: typeof drizzle;
  };
  const realDb = drizzleFn(pgClientRaw as any) as ReturnType<typeof drizzle>;
  return { realDb };
});

// Override the global @/lib/db mock (from tests/setup.ts) with a real DB
// so that incrementCompletedSteps issues SQL against the local Postgres.
vi.mock("@/lib/db", () => ({ db: realDb }));

// ---- schema + function under test ----------------------------------------
// These imports run after the mocks above are established.
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { incrementCompletedSteps } from "@/lib/workflow/executor/logging";

// ---- skip guard ----------------------------------------------------------
const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

function generateId(): string {
  return crypto.randomBytes(11).toString("base64url");
}

describe.skipIf(shouldSkip)("incrementCompletedSteps atomicity", () => {
  let testDb: ReturnType<typeof drizzle>;
  let pgClientOwned: ReturnType<typeof postgres>;
  let testUserId: string;
  let testOrgId: string;
  let testWorkflowId: string;

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";

    // A separate client for test assertions and setup.
    pgClientOwned = postgres(connectionString, { max: 5 });
    testDb = drizzle(pgClientOwned, {
      schema: { organization, users, workflowExecutions, workflows },
    });

    // Create a transient test user owned by this suite.
    testUserId = generateId();
    const now = new Date();
    await testDb.insert(users).values({
      id: testUserId,
      name: "Trace Race Test User",
      email: `trace-race-${testUserId}@techops.services`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });

    testOrgId = generateId();
    await testDb.insert(organization).values({
      id: testOrgId,
      name: testOrgId,
      slug: testOrgId,
      createdAt: now,
    });

    testWorkflowId = generateId();
    await testDb.insert(workflows).values({
      id: testWorkflowId,
      name: "Trace Race Test Workflow",
      userId: testUserId,
      organizationId: testOrgId,
      nodes: [],
      edges: [],
    });
  });

  afterAll(async () => {
    if (testWorkflowId) {
      await testDb
        .delete(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, testWorkflowId));
      await testDb.delete(workflows).where(eq(workflows.id, testWorkflowId));
    }
    if (testOrgId) {
      await testDb.delete(organization).where(eq(organization.id, testOrgId));
    }
    if (testUserId) {
      await testDb.delete(users).where(eq(users.id, testUserId));
    }
    await pgClientOwned.end();
  });

  beforeEach(async () => {
    await testDb
      .delete(workflowExecutions)
      .where(eq(workflowExecutions.workflowId, testWorkflowId));
  });

  async function createRunningExecution(): Promise<string> {
    const executionId = generateId();
    await testDb.insert(workflowExecutions).values({
      id: executionId,
      workflowId: testWorkflowId,
      userId: testUserId,
      status: "running",
      input: {},
      completedSteps: "0",
      executionTrace: [],
    });
    return executionId;
  }

  async function readExecution(executionId: string): Promise<{
    completedSteps: string | null;
    executionTrace: string[] | null;
  }> {
    const rows = await testDb
      .select({
        completedSteps: workflowExecutions.completedSteps,
        executionTrace: workflowExecutions.executionTrace,
      })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId));

    if (rows.length === 0) {
      throw new Error(`execution ${executionId} not found`);
    }
    return rows[0] as {
      completedSteps: string | null;
      executionTrace: string[] | null;
    };
  }

  it("appends 10 concurrent distinct nodeIds without loss", async () => {
    const executionId = await createRunningExecution();
    const nodeIds = Array.from(
      { length: 10 },
      (_, i) => `node-concurrent-${i}`
    );

    await Promise.all(
      nodeIds.map((nodeId) =>
        incrementCompletedSteps({
          executionId,
          nodeId,
          nodeName: nodeId,
          success: true,
        })
      )
    );

    const { completedSteps, executionTrace } = await readExecution(executionId);
    const trace = executionTrace ?? [];

    expect(trace).toHaveLength(10);
    expect(new Set(trace)).toEqual(new Set(nodeIds));
    expect(completedSteps).toBe("10");
  });

  it("sequential calls preserve order and count", async () => {
    const executionId = await createRunningExecution();
    const nodeIds = Array.from({ length: 5 }, (_, i) => `node-seq-${i}`);

    for (const nodeId of nodeIds) {
      await incrementCompletedSteps({
        executionId,
        nodeId,
        nodeName: nodeId,
        success: true,
      });
    }

    const { completedSteps, executionTrace } = await readExecution(executionId);
    const trace = executionTrace ?? [];

    expect(trace).toEqual(nodeIds);
    expect(completedSteps).toBe("5");
  });

  it("duplicate nodeId yields two trace entries (preserves for-each semantics)", async () => {
    const executionId = await createRunningExecution();

    await incrementCompletedSteps({
      executionId,
      nodeId: "foreach-body-node",
      nodeName: "foreach-body-node",
      success: true,
    });
    await incrementCompletedSteps({
      executionId,
      nodeId: "foreach-body-node",
      nodeName: "foreach-body-node",
      success: true,
    });

    const { completedSteps, executionTrace } = await readExecution(executionId);
    const trace = executionTrace ?? [];

    expect(trace).toHaveLength(2);
    expect(trace).toEqual(["foreach-body-node", "foreach-body-node"]);
    expect(completedSteps).toBe("2");
  });

  it("cancelled execution drops the write", async () => {
    const executionId = await createRunningExecution();

    await testDb
      .update(workflowExecutions)
      .set({ status: "cancelled" })
      .where(eq(workflowExecutions.id, executionId));

    await incrementCompletedSteps({
      executionId,
      nodeId: "node-after-cancel",
      nodeName: "node-after-cancel",
      success: true,
    });

    const { completedSteps, executionTrace } = await readExecution(executionId);
    const trace = executionTrace ?? [];

    expect(trace).toHaveLength(0);
    expect(completedSteps).toBe("0");
  });

  it("100 concurrent calls produce exactly 100 trace entries (stress)", async () => {
    const executionId = await createRunningExecution();
    const count = 100;
    const nodeIds = Array.from({ length: count }, (_, i) => `node-stress-${i}`);

    await Promise.all(
      nodeIds.map(async (nodeId) => {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.floor(Math.random() * 5))
        );
        return incrementCompletedSteps({
          executionId,
          nodeId,
          nodeName: nodeId,
          success: true,
        });
      })
    );

    const { completedSteps, executionTrace } = await readExecution(executionId);
    const trace = executionTrace ?? [];

    expect(trace).toHaveLength(count);
    expect(new Set(trace)).toEqual(new Set(nodeIds));
    expect(completedSteps).toBe(count.toString());
  }, 60_000);
});
