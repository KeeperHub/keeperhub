import "dotenv/config";
import { and, eq } from "drizzle-orm";
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
import { walletLocks } from "../../../lib/db/schema-extensions";

// Bypass the Next.js server-only guard — vitest runs in Node, not SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db. This suite needs real SQL to
// verify that the reaper's WHERE clauses actually filter what they claim.
vi.unmock("@/lib/db");

// Stub Prometheus so metric emission is a no-op in test runs.
vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordWorkflowExecutionError: vi.fn(),
}));

// internal-service-auth reads env vars at module load time; the module may
// already be cached by the time beforeAll runs. Mock auth at the function
// level so the test key is accepted regardless of load order.
const SERVICE_KEY = "test-keep644-reaper-key";
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: (request: Request) => {
    const key = request.headers.get("X-Service-Key");
    return key === SERVICE_KEY
      ? { authenticated: true, service: "scheduler" as const }
      : { authenticated: false, error: "Invalid service key" };
  },
  isFromService: vi.fn(() => false),
  getInternalService: vi.fn(() => null),
}));

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep644_";

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000);

type GetHandler = (request: Request) => Promise<Response>;
type ReaperBody = { reapedCount: number; reapedIds: string[] };

describe.skipIf(SKIP)("reaper route - real-DB integration", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  // Fixed IDs scoped to this suite so cleanup is exact.
  const orgId = `${PREFIX}org`;
  const userId = `${PREFIX}user`;
  const workflowId = `${PREFIX}wf`;
  const staleRunningId = `${PREFIX}stale_running`;
  const activeRunningId = `${PREFIX}active_running`;
  const stalePendingId = `${PREFIX}stale_pending`;
  const successId = `${PREFIX}success`;
  const cancelledId = `${PREFIX}cancelled`;

  // Wallet lock seeded against a test-only address that won't collide with
  // any real workflow data.
  const TEST_WALLET = "0x000000000000000000000000keep644test";
  const TEST_CHAIN_ID = 999_644;

  // Captured once from the single GET call made in beforeAll.
  let reaperBody: ReaperBody;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM wallet_locks WHERE wallet_address = ${TEST_WALLET} AND chain_id = ${TEST_CHAIN_ID}`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    await db.insert(organization).values({
      id: orgId,
      name: "keep644 test org",
      slug: orgId,
      createdAt: now,
    });

    await db.insert(users).values({
      id: userId,
      email: `${userId}@keep644.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(workflows).values({
      id: workflowId,
      name: "keep644 reaper test workflow",
      userId,
      organizationId: orgId,
      nodes: [],
      edges: [],
    });

    const base = { workflowId, userId };

    // Stale running: no step logs, started 2 hrs ago → reaped.
    await db.insert(workflowExecutions).values({
      id: staleRunningId,
      ...base,
      status: "running",
      startedAt: TWO_HOURS_AGO,
    });

    // Active running: same age but shielded by a recent step-log completedAt.
    await db.insert(workflowExecutions).values({
      id: activeRunningId,
      ...base,
      status: "running",
      startedAt: TWO_HOURS_AGO,
    });

    // Stale pending: no step logs, started 10 min ago → reaped (> 5 min threshold).
    await db.insert(workflowExecutions).values({
      id: stalePendingId,
      ...base,
      status: "pending",
      startedAt: TEN_MINUTES_AGO,
    });

    // Terminal rows that must never be touched.
    await db.insert(workflowExecutions).values({
      id: successId,
      ...base,
      status: "success",
      startedAt: TWO_HOURS_AGO,
      completedAt: TWO_HOURS_AGO,
    });
    await db.insert(workflowExecutions).values({
      id: cancelledId,
      ...base,
      status: "cancelled",
      startedAt: TWO_HOURS_AGO,
      completedAt: TWO_HOURS_AGO,
    });

    // Recent step log for activeRunningId → its completedAt is within the
    // running threshold, so the execution is excluded from reaping.
    await db.insert(workflowExecutionLogs).values({
      executionId: activeRunningId,
      nodeId: "active-node-1",
      nodeName: "Active Step",
      nodeType: "action",
      status: "success",
      completedAt: now,
    });

    // Orphaned *running* step log for staleRunningId → reaper must close it.
    await db.insert(workflowExecutionLogs).values({
      executionId: staleRunningId,
      nodeId: "stuck-node-1",
      nodeName: "Stuck Step",
      nodeType: "action",
      status: "running",
      startedAt: TWO_HOURS_AGO,
    });

    // Wallet lock held by the stale execution → reaper must release it.
    await db.insert(walletLocks).values({
      walletAddress: TEST_WALLET,
      chainId: TEST_CHAIN_ID,
      lockedBy: staleRunningId,
      lockedAt: TWO_HOURS_AGO,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const { GET } = (await import(
      "../../../app/api/internal/reaper/route"
    )) as { GET: GetHandler };

    const res = await GET(
      new Request("http://localhost/api/internal/reaper", {
        headers: { "X-Service-Key": SERVICE_KEY },
      })
    );
    expect(res.status).toBe(200);
    reaperBody = (await res.json()) as ReaperBody;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("reports reaped IDs in the response body", () => {
    expect(reaperBody.reapedIds).toContain(staleRunningId);
    expect(reaperBody.reapedIds).toContain(stalePendingId);
    expect(reaperBody.reapedIds).not.toContain(activeRunningId);
    expect(reaperBody.reapedIds).not.toContain(successId);
    expect(reaperBody.reapedIds).not.toContain(cancelledId);
    expect(reaperBody.reapedCount).toBe(2);
  });

  it("moves the stale running execution to system_error state with classification", async () => {
    const [row] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, staleRunningId));

    expect(row.status).toBe("system_error");
    expect(row.error).toMatch(/timed out/i);
    expect(row.completedAt).not.toBeNull();
    expect(row.errorCategory).toBe("workflow_engine");
    expect(row.errorType).toBe("system");
  });

  it("moves the stale pending execution to system_error state", async () => {
    const [row] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, stalePendingId));

    expect(row.status).toBe("system_error");
    expect(row.completedAt).not.toBeNull();
  });

  it("does not reap running executions with recent step activity", async () => {
    const [row] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, activeRunningId));

    expect(row.status).toBe("running");
    expect(row.completedAt).toBeNull();
  });

  it("does not overwrite already-terminal executions", async () => {
    const [successRow] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, successId));
    expect(successRow.status).toBe("success");

    const [cancelledRow] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, cancelledId));
    expect(cancelledRow.status).toBe("cancelled");
  });

  it("closes orphaned running step logs for reaped executions", async () => {
    const [log] = await db
      .select()
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.executionId, staleRunningId),
          eq(workflowExecutionLogs.nodeId, "stuck-node-1")
        )
      );

    expect(log.status).toBe("error");
    expect(log.completedAt).not.toBeNull();
    expect(log.error).toBe("Step did not record completion");
  });

  it("releases wallet locks held by reaped executions", async () => {
    const [lock] = await db
      .select()
      .from(walletLocks)
      .where(
        and(
          eq(walletLocks.walletAddress, TEST_WALLET),
          eq(walletLocks.chainId, TEST_CHAIN_ID)
        )
      );

    expect(lock.lockedBy).toBeNull();
    expect(lock.lockedAt).toBeNull();
  });
});
