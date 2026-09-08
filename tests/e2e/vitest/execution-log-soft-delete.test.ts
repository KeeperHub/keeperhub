import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// Bypass the Next.js server-only guard - vitest runs in Node, not SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db. This suite needs real SQL to verify
// that the delete paths write deleted_at instead of removing the rows.
vi.unmock("@/lib/db");

const PREFIX = "test_keep1199_";
const ORG_ID = `${PREFIX}org`;
const USER_ID = `${PREFIX}user`;

// Auth is not what this suite exercises. Grant full access to the seeded org so
// both handlers reach the delete branch.
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: () =>
    Promise.resolve({
      userId: USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
      apiKeyId: null,
      scope: null,
    }),
  authFailureResponse: () => new Response(null, { status: 401 }),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: () => null,
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: () =>
    Promise.resolve({ hasFullAccess: true, isDeleted: false }),
  validateWorkflowAccess: () => Promise.resolve({ authorized: true }),
}));

// security_audit_log is append-only at the DB level (BEFORE DELETE OR UPDATE
// trigger), and its FK to users is ON DELETE SET NULL, so a real audit write
// here would make the suite impossible to clean up after itself.
vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: vi.fn(() => Promise.resolve()),
  buildAuditMetadata: vi.fn(() => ({})),
}));

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

type LogRow = { id: string; deleted_at: Date | null; gas_used_wei: string };

describe.skipIf(SKIP)("execution log soft delete - real-DB integration", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  // One workflow per delete path so the two runs cannot mask each other.
  const purgeWorkflowId = `${PREFIX}wf_purge`;
  const cascadeWorkflowId = `${PREFIX}wf_cascade`;
  const purgeExecutionId = `${PREFIX}exec_purge`;
  const cascadeExecutionId = `${PREFIX}exec_cascade`;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_schedules WHERE workflow_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    // The org and user are left in place on purpose. security_audit_log is
    // append-only at the DB level and its FKs are ON DELETE SET NULL, so once
    // any run has written an audit row the user can never be deleted again.
    // Both are prefixed and re-seeded idempotently instead.
  }

  async function logsFor(executionId: string): Promise<LogRow[]> {
    return (await queryClient`
      SELECT id, deleted_at, gas_used_wei
      FROM workflow_execution_logs
      WHERE execution_id = ${executionId}
      ORDER BY id
    `) as unknown as LogRow[];
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    await db
      .insert(organization)
      .values({
        id: ORG_ID,
        name: "keep1199 test org",
        slug: ORG_ID,
        createdAt: now,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: USER_ID,
        email: `${USER_ID}@keep1199.test`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    for (const id of [purgeWorkflowId, cascadeWorkflowId]) {
      await db.insert(workflows).values({
        id,
        name: `keep1199 ${id}`,
        userId: USER_ID,
        organizationId: ORG_ID,
        nodes: [],
        edges: [],
      });
    }

    // Two gas-bearing steps per run: the per-network breakdown aggregates these
    // columns, so they are what must survive a delete.
    const runs: [string, string][] = [
      [purgeExecutionId, purgeWorkflowId],
      [cascadeExecutionId, cascadeWorkflowId],
    ];

    for (const [executionId, workflowId] of runs) {
      await db.insert(workflowExecutions).values({
        id: executionId,
        workflowId,
        organizationId: ORG_ID,
        userId: USER_ID,
        status: "success",
        startedAt: now,
        completedAt: now,
      });

      for (const step of [1, 2]) {
        await db.insert(workflowExecutionLogs).values({
          id: `${executionId}_step${step}`,
          executionId,
          nodeId: `node-${step}`,
          nodeName: `Node ${step}`,
          nodeType: "web3/read-contract",
          status: "success",
          startedAt: now,
          completedAt: now,
          network: "1",
          gasUsedWei: "21000",
        });
      }
    }
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("seeds two gas-bearing log rows per run", async () => {
    expect(await logsFor(purgeExecutionId)).toHaveLength(2);
    expect(await logsFor(cascadeExecutionId)).toHaveLength(2);
  });

  it("purging run history soft-deletes the step logs instead of erasing them", async () => {
    const { DELETE } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );

    const response = await DELETE(
      new Request(
        `http://localhost/api/workflows/${purgeWorkflowId}/executions`,
        { method: "DELETE" }
      ),
      { params: Promise.resolve({ workflowId: purgeWorkflowId }) }
    );
    expect(response.status).toBe(200);

    const logs = await logsFor(purgeExecutionId);
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.deleted_at).not.toBeNull();
      // The gas the analytics breakdown sums is still on the row.
      expect(log.gas_used_wei).toBe("21000");
    }

    const [execution] = (await queryClient`
      SELECT deleted_at FROM workflow_executions WHERE id = ${purgeExecutionId}
    `) as unknown as Array<{ deleted_at: Date | null }>;
    expect(execution.deleted_at).not.toBeNull();
  });

  it("force-deleting a workflow soft-deletes the step logs instead of erasing them", async () => {
    const { DELETE } = await import("@/app/api/workflows/[workflowId]/route");

    const response = await DELETE(
      new Request(
        `http://localhost/api/workflows/${cascadeWorkflowId}?force=true`,
        { method: "DELETE" }
      ),
      { params: Promise.resolve({ workflowId: cascadeWorkflowId }) }
    );
    expect(response.status).toBe(200);

    const logs = await logsFor(cascadeExecutionId);
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.deleted_at).not.toBeNull();
      expect(log.gas_used_wei).toBe("21000");
    }
  });

  it("keeps purged gas in the per-network breakdown the analytics page reads", async () => {
    // Drives the real production query rather than a hand-written copy of it,
    // so the assertion cannot drift from what the page actually shows. A
    // "custom" range bypasses the analytics cache (see isCacheableRange).
    const { getNetworkBreakdown } = await import("@/lib/analytics/queries");

    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const breakdown = await getNetworkBreakdown(ORG_ID, "custom", start, end);

    const mainnet = breakdown.find((n) => n.network === "1");
    expect(mainnet).toBeDefined();
    // Four steps at 21000 across the two purged runs. Zero here would mean the
    // gas history died with the purge, which is the whole point of the change.
    expect(mainnet?.totalGasWei).toBe("84000");
  });

  it("hides purged steps from the run detail view", async () => {
    const [row] = (await queryClient`
      SELECT COUNT(*)::int AS n
      FROM workflow_execution_logs
      WHERE execution_id = ${purgeExecutionId}
        AND deleted_at IS NULL
    `) as unknown as Array<{ n: number }>;

    expect(row.n).toBe(0);
  });

  it("stamps the owning org on the execution row itself", async () => {
    const [row] = (await queryClient`
      SELECT organization_id FROM workflow_executions WHERE id = ${purgeExecutionId}
    `) as unknown as Array<{ organization_id: string | null }>;

    expect(row.organization_id).toBe(ORG_ID);
  });
});
