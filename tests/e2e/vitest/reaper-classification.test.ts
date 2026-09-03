import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  walletLocks,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { reapStaleExecutions } from "@/lib/reaper/reap-stale-executions";

// tests/setup.ts globally mocks @/lib/db; reapStaleExecutions imports the real
// module, so restore it and drive the reaper against a real database.
vi.unmock("@/lib/db");
// finalize-error (reached via the reaper's metric emit) imports "server-only",
// which throws at import time outside a React Server context. Stub it, matching
// the pattern used by the other lib/executor suites.
vi.mock("server-only", () => ({}));

// The reaper classifies a stuck execution by whether it ever produced a step
// log, not by its raw status. A `running` row with NO step logs never entered
// the workflow body (pod died/never scheduled) and is booked as
// infrastructure/P-0001, like `pending`/`phantom` - NOT workflow_engine/E-0001.
// It is still reaped at the full 30-min running threshold (not the 5-min pending
// cutoff): a durably enqueued run also sits running+no-logs until a worker picks
// it up, so reaping early would false-fail healthy queued runs. This exercises
// that CASE + the OR of stale conditions against a real Postgres.

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep934_reaper_";
// reapStaleExecutions(THRESHOLD): running-with-logs is stale past THRESHOLD min;
// pending/phantom/running-no-logs are stale past the fixed 5-min pending cutoff.
const THRESHOLD_MINUTES = 30;

type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "phantom"
  | "system_error";

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

describe.skipIf(SKIP)(
  "reaper classification (never-progressed running)",
  () => {
    let queryClient: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle>;

    const ownerId = `${PREFIX}user`;
    const orgId = `${PREFIX}org`;
    const workflowId = `${PREFIX}wf`;

    // Fixture ids, seeded once in beforeAll and reaped in a single pass.
    const ID = {
      runningNoLogsStale: `${PREFIX}running_nolog_stale`,
      runningWithLogStale: `${PREFIX}running_log_stale`,
      runningRecentlyActive: `${PREFIX}running_recent`,
      runningOldCompletedStep: `${PREFIX}running_old_completed`,
      pendingNoLogsStale: `${PREFIX}pending_nolog_stale`,
      phantomStale: `${PREFIX}phantom_stale`,
      runningNoLogsQueued: `${PREFIX}running_nolog_queued`,
      runningWithLogFresh: `${PREFIX}running_log_fresh`,
    };

    let reapedIds: string[] = [];

    // Two wallets, so the two lock fixtures below do not collide on the
    // (wallet_address, chain_id) primary key.
    const LAPSED_LOCK_WALLET = `0x${"1".repeat(40)}`;
    const LIVE_LOCK_WALLET = `0x${"2".repeat(40)}`;
    const LOCK_CHAIN_ID = 987_654;

    async function cleanup(): Promise<void> {
      await queryClient`DELETE FROM wallet_locks WHERE wallet_address IN (${LAPSED_LOCK_WALLET}, ${LIVE_LOCK_WALLET})`;
      await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
      await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    }

    async function seedExecution(
      id: string,
      status: ExecutionStatus,
      startedAt: Date
    ): Promise<void> {
      await db.insert(workflowExecutions).values({
        id,
        workflowId,
        userId: ownerId,
        status,
        startedAt,
      });
    }

    async function seedStepLog(
      executionId: string,
      status: "running" | "success",
      completedAt: Date | null
    ): Promise<void> {
      await db.insert(workflowExecutionLogs).values({
        executionId,
        nodeId: "trigger",
        nodeName: "Trigger",
        nodeType: "trigger",
        status,
        startedAt: minutesAgo(40),
        completedAt,
      });
    }

    async function readExecution(id: string) {
      const [row] = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, id));
      return row;
    }

    beforeAll(async () => {
      queryClient = postgres(DATABASE_URL);
      db = drizzle(queryClient);
      await cleanup();

      await db.insert(users).values({
        id: ownerId,
        email: `${ownerId}@keep934.test`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(organization).values({
        id: orgId,
        name: orgId,
        slug: orgId,
        createdAt: new Date(),
      });
      await db.insert(workflows).values({
        id: workflowId,
        name: workflowId,
        userId: ownerId,
        organizationId: orgId,
        nodes: [],
        edges: [],
        visibility: "private",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // running, never produced a step log, older than the 30-min running
      // threshold: reaped as infrastructure/P-0001 (not workflow_engine/E-0001)
      // because it never entered the workflow body.
      await seedExecution(ID.runningNoLogsStale, "running", minutesAgo(31));

      // running, produced a step log that never completed, older than 30 min:
      // genuinely stalled after progressing - workflow_engine/E-0001.
      await seedExecution(ID.runningWithLogStale, "running", minutesAgo(31));
      await seedStepLog(ID.runningWithLogStale, "running", null);

      // running, older than 30 min, but a step COMPLETED within the threshold:
      // actively progressing - never reaped.
      await seedExecution(ID.runningRecentlyActive, "running", minutesAgo(31));
      await seedStepLog(ID.runningRecentlyActive, "success", minutesAgo(1));

      // running, older than 30 min, with a step that COMPLETED before the
      // threshold window opened: progress stopped, so it IS reaped. This is the
      // boundary the exclusion must respect - "has a completed step" is not the
      // test, "completed one inside the window" is.
      await seedExecution(
        ID.runningOldCompletedStep,
        "running",
        minutesAgo(45)
      );
      await seedStepLog(ID.runningOldCompletedStep, "success", minutesAgo(40));

      // pending, no logs, older than 5 min: unchanged - infrastructure/P-0001.
      await seedExecution(ID.pendingNoLogsStale, "pending", minutesAgo(6));

      // phantom, older than 5 min: unchanged - infrastructure/P-0005.
      await seedExecution(ID.phantomStale, "phantom", minutesAgo(6));

      // running, no logs, but only 20 min in (past the 5-min pending cutoff, well
      // under the 30-min running threshold): a durably enqueued run waiting on a
      // worker looks identical to this, so it must NOT be reaped early - this is
      // the regression guard against false-failing healthy queued runs.
      await seedExecution(ID.runningNoLogsQueued, "running", minutesAgo(20));

      // running, has a step log, only 10 min in: progressing normally, well under
      // the 30-min running threshold - not reaped.
      await seedExecution(ID.runningWithLogFresh, "running", minutesAgo(10));
      await seedStepLog(ID.runningWithLogFresh, "running", null);

      // Two wallet locks held by executions this pass reaps. The only thing
      // separating them is whether a heartbeat is still renewing expires_at:
      // the lapsed one is safe to clear, the live one is a holder mid-write
      // whose nonce a waiter would otherwise duplicate.
      await db.insert(walletLocks).values([
        {
          walletAddress: LAPSED_LOCK_WALLET,
          chainId: LOCK_CHAIN_ID,
          lockedBy: ID.runningNoLogsStale,
          lockedAt: minutesAgo(40),
          expiresAt: minutesAgo(35),
        },
        {
          walletAddress: LIVE_LOCK_WALLET,
          chainId: LOCK_CHAIN_ID,
          lockedBy: ID.runningWithLogStale,
          lockedAt: minutesAgo(40),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      ]);

      // NOTE: reapStaleExecutions is GLOBAL - it reaps every stale row in the DB,
      // not just this suite's PREFIX. On the shared local/CI database this can
      // flip stale rows another suite left behind. Assertions below are therefore
      // scoped by fixture id (toContain / not.toContain), never by the exact
      // contents of reapedIds, and vitest runs test files serially
      // (fileParallelism:false) so no other suite is mutating rows concurrently.
      reapedIds = await reapStaleExecutions(THRESHOLD_MINUTES);
    });

    afterAll(async () => {
      await cleanup();
      await queryClient.end();
    });

    it("reaps a never-progressed running row as infrastructure/P-0001 (the fix)", async () => {
      expect(reapedIds).toContain(ID.runningNoLogsStale);
      const row = await readExecution(ID.runningNoLogsStale);
      expect(row.status).toBe("system_error");
      expect(row.errorCategory).toBe("infrastructure");
      expect(row.errorCode).toBe("P-0001");
      expect(row.errorType).toBe("system");
    });

    it("reaps a progressed-then-stalled running row as workflow_engine/E-0001", async () => {
      expect(reapedIds).toContain(ID.runningWithLogStale);
      const row = await readExecution(ID.runningWithLogStale);
      expect(row.status).toBe("system_error");
      expect(row.errorCategory).toBe("workflow_engine");
      expect(row.errorCode).toBe("E-0001");
    });

    it("does NOT reap a running row with a recently completed step", async () => {
      expect(reapedIds).not.toContain(ID.runningRecentlyActive);
      expect((await readExecution(ID.runningRecentlyActive)).status).toBe(
        "running"
      );
    });

    it("DOES reap a running row whose completed step predates the window", async () => {
      expect(reapedIds).toContain(ID.runningOldCompletedStep);
      const row = await readExecution(ID.runningOldCompletedStep);
      expect(row.status).toBe("system_error");
      expect(row.errorCategory).toBe("workflow_engine");
      expect(row.errorCode).toBe("E-0001");
    });

    it("reaps a stale pending row as infrastructure/P-0001 (unchanged)", async () => {
      expect(reapedIds).toContain(ID.pendingNoLogsStale);
      const row = await readExecution(ID.pendingNoLogsStale);
      expect(row.status).toBe("system_error");
      expect(row.errorCategory).toBe("infrastructure");
      expect(row.errorCode).toBe("P-0001");
    });

    it("reaps a stale phantom row as infrastructure/P-0005 (unchanged)", async () => {
      expect(reapedIds).toContain(ID.phantomStale);
      const row = await readExecution(ID.phantomStale);
      expect(row.status).toBe("system_error");
      expect(row.errorCategory).toBe("infrastructure");
      expect(row.errorCode).toBe("P-0005");
    });

    it("does NOT reap a running-no-logs row still under the running threshold (queued-run guard)", async () => {
      expect(reapedIds).not.toContain(ID.runningNoLogsQueued);
      expect((await readExecution(ID.runningNoLogsQueued)).status).toBe(
        "running"
      );
    });

    it("does NOT reap a progressing running row still under the running threshold", async () => {
      expect(reapedIds).not.toContain(ID.runningWithLogFresh);
      expect((await readExecution(ID.runningWithLogFresh)).status).toBe(
        "running"
      );
    });

    it("clears a lapsed wallet lock held by a reaped execution", async () => {
      const [row] = await db
        .select()
        .from(walletLocks)
        .where(eq(walletLocks.walletAddress, LAPSED_LOCK_WALLET));
      expect(row.lockedBy).toBeNull();
    });

    it("leaves a wallet lock a live heartbeat is still renewing", async () => {
      const [row] = await db
        .select()
        .from(walletLocks)
        .where(eq(walletLocks.walletAddress, LIVE_LOCK_WALLET));
      expect(row.lockedBy).toBe(ID.runningWithLogStale);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  }
);
