import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimPendingForExecution,
  claimPhantomForExecution,
  type DbSchema,
  discardPhantomRow,
  resolvePhantomToError,
} from "../../../keeperhub-executor/lib/db-helpers";
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// tests/setup.ts globally mocks @/lib/db. This suite drives the claim helpers
// against a real database via its own handle, so restore the genuine module.
vi.unmock("@/lib/db");

// The phantom -> pending claim is a compare-and-set in SQL (WHERE
// status='phantom'). It must (a) claim a real phantom row and stamp its input,
// and (b) be a no-op for any row not in 'phantom' (missing, or already advanced
// by a duplicate SQS delivery) so the executor's fallback insert never produces
// a duplicate run. The guard lives in SQL, so this exercises it against a real
// database rather than a mock.

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep693_phantom_";

// Content hash the executor stamps when it claims the phantom; the test passes
// a fixed value since it drives the helper directly without loading a workflow.
const HASH = "test_executed_workflow_hash";

type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "phantom"
  | "system_error";

describe.skipIf(SKIP)("consume-path claim helpers", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  // The claim helpers are typed against the executor's DbSchema; the test's
  // schema-less handle is structurally compatible for the .update() they issue.
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
    input: Record<string, unknown> | null = null
  ): Promise<void> {
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status,
      input,
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
      email: `${ownerId}@keep693.test`,
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

  it("claims a phantom row to pending and stamps its input", async () => {
    const id = `${PREFIX}claim`;
    await seedExecution(id, "phantom");

    const outcome = await claimPhantomForExecution(
      execDb,
      id,
      { triggered: 1 },
      HASH
    );

    expect(outcome).toBe("claimed");
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    expect(row.input).toEqual({ triggered: 1 });
    expect(row.executedWorkflowHash).toBe(HASH);
  });

  it("returns already_advanced (no-op) when the row is not phantom", async () => {
    const id = `${PREFIX}running`;
    await seedExecution(id, "running", { original: true });

    const outcome = await claimPhantomForExecution(
      execDb,
      id,
      { stamped: 2 },
      HASH
    );

    expect(outcome).toBe("already_advanced");
    const row = await readExecution(id);
    expect(row.status).toBe("running");
    // Input must be untouched -- the CAS matched no row.
    expect(row.input).toEqual({ original: true });
  });

  it("returns already_advanced for every terminal status", async () => {
    for (const status of [
      "success",
      "error",
      "cancelled",
      "system_error",
    ] as const) {
      const id = `${PREFIX}term_${status}`;
      await seedExecution(id, status);
      expect(await claimPhantomForExecution(execDb, id, {}, HASH)).toBe(
        "already_advanced"
      );
    }
  });

  it("returns not_found when the execution id does not exist", async () => {
    const outcome = await claimPhantomForExecution(
      execDb,
      `${PREFIX}missing`,
      {},
      HASH
    );
    expect(outcome).toBe("not_found");
  });

  it("is exactly-once: a duplicate claim of an already-claimed row is dropped", async () => {
    const id = `${PREFIX}dup`;
    await seedExecution(id, "phantom");

    const first = await claimPhantomForExecution(execDb, id, { n: 1 }, HASH);
    const second = await claimPhantomForExecution(execDb, id, { n: 2 }, HASH);

    expect(first).toBe("claimed");
    expect(second).toBe("already_advanced");
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    // The losing duplicate must not overwrite the input the winner stamped.
    expect(row.input).toEqual({ n: 1 });
  });

  it("claiming a phantom flips a non-billable row to billable (it now runs)", async () => {
    const id = `${PREFIX}billable`;
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status: "phantom",
      billable: false,
    });

    const outcome = await claimPhantomForExecution(execDb, id, {}, HASH);

    expect(outcome).toBe("claimed");
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    expect(row.billable).toBe(true);
  });

  it("re-claims a reaped-never-ran row (system_error P-0005) and clears the reaper stamp", async () => {
    const id = `${PREFIX}reaped_phantom`;
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status: "system_error",
      errorCode: "P-0005",
      error: "Execution timed out",
      completedAt: new Date(),
    });

    const outcome = await claimPhantomForExecution(
      execDb,
      id,
      { retry: 1 },
      HASH
    );

    expect(outcome).toBe("claimed");
    const row = await readExecution(id);
    expect(row.status).toBe("pending");
    expect(row.input).toEqual({ retry: 1 });
    expect(row.errorCode).toBeNull();
    expect(row.error).toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it("does NOT re-claim a system_error from a run failure (E-0001)", async () => {
    const id = `${PREFIX}reaped_running`;
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status: "system_error",
      errorCode: "E-0001",
    });

    expect(await claimPhantomForExecution(execDb, id, {}, HASH)).toBe(
      "already_advanced"
    );
    expect((await readExecution(id)).status).toBe("system_error");
  });

  it("claimPendingForExecution claims a pending row to running", async () => {
    const id = `${PREFIX}pending_claim`;
    await seedExecution(id, "pending");

    const outcome = await claimPendingForExecution(execDb, id);

    expect(outcome).toBe("claimed");
    expect((await readExecution(id)).status).toBe("running");
  });

  it("claimPendingForExecution re-claims a reaped-never-ran row (P-0001)", async () => {
    const id = `${PREFIX}pending_reaped`;
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status: "system_error",
      errorCode: "P-0001",
    });

    expect(await claimPendingForExecution(execDb, id)).toBe("claimed");
    expect((await readExecution(id)).status).toBe("running");
  });

  it("claimPendingForExecution drops a duplicate (row already running)", async () => {
    const id = `${PREFIX}pending_dup`;
    await seedExecution(id, "running");

    expect(await claimPendingForExecution(execDb, id)).toBe("already_advanced");
    // Second delivery of an already-claimed manual/webhook row.
    expect((await readExecution(id)).status).toBe("running");
  });

  it("claimPendingForExecution returns not_found for a missing row", async () => {
    expect(
      await claimPendingForExecution(execDb, `${PREFIX}pending_missing`)
    ).toBe("not_found");
  });

  it("discardPhantomRow deletes a phantom row (intentional skip)", async () => {
    const id = `${PREFIX}discard`;
    await seedExecution(id, "phantom");

    await discardPhantomRow(execDb, id);

    expect(await readExecution(id)).toBeUndefined();
  });

  it("discardPhantomRow leaves a non-phantom row intact", async () => {
    const id = `${PREFIX}discard_running`;
    await seedExecution(id, "running");

    await discardPhantomRow(execDb, id);

    expect((await readExecution(id))?.status).toBe("running");
  });

  it("resolvePhantomToError marks a phantom as a billing/user error", async () => {
    const id = `${PREFIX}resolve`;
    await seedExecution(id, "phantom");

    await resolvePhantomToError(execDb, id, {
      error: "over quota",
      errorCategory: "billing",
      errorType: "user",
    });

    const row = await readExecution(id);
    expect(row.status).toBe("error");
    expect(row.error).toBe("over quota");
    expect(row.errorCategory).toBe("billing");
    expect(row.errorType).toBe("user");
    // User-actionable errors carry no system code.
    expect(row.errorCode).toBeNull();
  });

  it("resolvePhantomToError leaves a non-phantom row intact", async () => {
    const id = `${PREFIX}resolve_running`;
    await seedExecution(id, "running");

    await resolvePhantomToError(execDb, id, {
      error: "x",
      errorCategory: "billing",
      errorType: "user",
    });

    expect((await readExecution(id))?.status).toBe("running");
  });
});
