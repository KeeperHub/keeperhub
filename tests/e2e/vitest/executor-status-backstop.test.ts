import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DbSchema,
  failExecutionAsSystemError,
  updateExecutionStatus,
} from "../../../keeperhub-executor/lib/db-helpers";
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// tests/setup.ts globally mocks @/lib/db. This suite drives updateExecutionStatus
// against a real database via its own handle, so restore the genuine module.
vi.unmock("@/lib/db");

// Proves the guard that makes the runner/in-process terminal-status write a safe
// backstop. executeWorkflow is the authoritative writer of the final status; the
// executors re-issue success/error through updateExecutionStatus only to close a
// row whose engine write was lost. The WHERE guard must therefore: (a) update a
// still-running row, and (b) never overwrite a row already in a terminal state
// (success/error/cancelled) - otherwise the re-issued write would clobber the
// engine's reconciled status. The guard lives in SQL, so this exercises it
// against a real database rather than a mock.

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep611_backstop_";

type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "phantom"
  | "system_error";

describe.skipIf(SKIP)("updateExecutionStatus terminal-state guard", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  // updateExecutionStatus is typed against the executor's DbSchema; the test's
  // schema-less handle is structurally compatible for the .update() it issues.
  let execDb: PostgresJsDatabase<DbSchema>;

  const ownerId = `${PREFIX}user`;
  const orgId = `${PREFIX}org`;
  const workflowId = `${PREFIX}wf`;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function seedExecution(
    id: string,
    status: ExecutionStatus,
    extra: { output?: unknown; error?: string } = {}
  ): Promise<void> {
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status,
      output: extra.output ?? null,
      error: extra.error ?? null,
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
    execDb = db as unknown as PostgresJsDatabase<DbSchema>;
    await cleanup();

    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@keep611.test`,
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
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("closes a still-running row (the lost engine-write backstop case)", async () => {
    const id = `${PREFIX}running`;
    await seedExecution(id, "running");

    await updateExecutionStatus(execDb, id, "success", {
      output: { ok: true },
    });

    const row = await readExecution(id);
    expect(row.status).toBe("success");
    expect(row.output).toEqual({ ok: true });
    expect(row.completedAt).not.toBeNull();
  });

  it("does not clobber a row the engine already marked success", async () => {
    const id = `${PREFIX}success`;
    await seedExecution(id, "success", { output: { original: true } });

    // The runner's result was a failure, but the engine reconciled to success
    // first. The backstop must not flip it back to error.
    await updateExecutionStatus(execDb, id, "error", {
      error: "stale failure",
    });

    const row = await readExecution(id);
    expect(row.status).toBe("success");
    expect(row.error).toBeNull();
    expect(row.output).toEqual({ original: true });
  });

  it("does not clobber a row the engine already marked error", async () => {
    const id = `${PREFIX}error`;
    await seedExecution(id, "error", { error: "real failure" });

    // Exercises the ne(status, 'error') clause: a re-issued write (even a
    // success) must not overwrite the engine's terminal error and its fields.
    await updateExecutionStatus(execDb, id, "success", {
      output: { ok: true },
    });

    const row = await readExecution(id);
    expect(row.status).toBe("error");
    expect(row.error).toBe("real failure");
  });

  it("does not clobber a cancelled row", async () => {
    const id = `${PREFIX}cancelled`;
    await seedExecution(id, "cancelled");

    await updateExecutionStatus(execDb, id, "error", { error: "late" });

    const row = await readExecution(id);
    expect(row.status).toBe("cancelled");
    expect(row.error).toBeNull();
  });

  // The SQS consumer backstop: when message processing throws for a reason the
  // inner dispatch handlers did not record, mark the in-flight row system_error
  // immediately instead of leaving it for the reaper. The CAS only matches
  // phantom/pending so it never clobbers a row the runtime already advanced, and
  // the boolean return tells the caller whether the mark actually applied.
  describe("failExecutionAsSystemError backstop CAS", () => {
    it("marks a phantom row system_error and reports it applied", async () => {
      const id = `${PREFIX}fail_phantom`;
      await seedExecution(id, "phantom");

      const marked = await failExecutionAsSystemError(execDb, id, {
        error: "Message processing failed: boom",
        errorCode: "E-0004",
      });

      expect(marked).toBe(true);
      const row = await readExecution(id);
      expect(row.status).toBe("system_error");
      expect(row.errorType).toBe("system");
      expect(row.errorCategory).toBe("infrastructure");
      expect(row.errorCode).toBe("E-0004");
      expect(row.completedAt).not.toBeNull();
    });

    it("marks a pending row system_error", async () => {
      const id = `${PREFIX}fail_pending`;
      await seedExecution(id, "pending");

      const marked = await failExecutionAsSystemError(execDb, id, {
        error: "boom",
        errorCode: "E-0004",
      });

      expect(marked).toBe(true);
      expect((await readExecution(id)).status).toBe("system_error");
    });

    it("is a no-op on an already-running row and reports it did not apply", async () => {
      const id = `${PREFIX}fail_running`;
      await seedExecution(id, "running");

      const marked = await failExecutionAsSystemError(execDb, id, {
        error: "boom",
        errorCode: "E-0004",
      });

      // The runtime already owns this row; the backstop must leave it for the
      // reaper rather than clobber it, and signal that it did not apply.
      expect(marked).toBe(false);
      expect((await readExecution(id)).status).toBe("running");
    });

    it("reports a no-op for a missing executionId", async () => {
      const marked = await failExecutionAsSystemError(execDb, undefined, {
        error: "boom",
        errorCode: "E-0004",
      });
      expect(marked).toBe(false);
    });
  });
});
