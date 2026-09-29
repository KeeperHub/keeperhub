import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
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
import {
  organization,
  users,
  workflowState,
  workflows,
} from "../../lib/db/schema";
import {
  getWorkflowStateValue,
  setWorkflowStateValue,
  WORKFLOW_STATE_LIMITS,
} from "../../lib/workflow/nodes/workflow-state/store";

// tests/setup.ts globally mocks @/lib/db. The store takes its executor as a
// parameter, so this suite passes its own real handle.
vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

// The compare-and-set and the key ceiling live in SQL (a versioned UPDATE and
// a count guarded by an advisory lock), so they are exercised against a real
// database rather than a mock.

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_workflow_state_";

describe("workflow state store", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const ownerId = `${PREFIX}user`;
  const orgId = `${PREFIX}org`;
  const workflowId = `${PREFIX}wf`;
  const scope = { workflowId };

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function expireKey(key: string): Promise<void> {
    await db
      .update(workflowState)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(workflowState.workflowId, workflowId),
          eq(workflowState.key, key)
        )
      );
  }

  /**
   * Run `fn` with every insert into workflow_state held for 200ms before it
   * lands, so concurrent writers overlap deterministically instead of
   * finishing one after another.
   */
  async function withSlowInserts<T>(fn: () => Promise<T>): Promise<T> {
    await queryClient.unsafe(`
      CREATE OR REPLACE FUNCTION ${PREFIX}slow_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${PREFIX}slow_insert BEFORE INSERT ON workflow_state
        FOR EACH ROW EXECUTE FUNCTION ${PREFIX}slow_insert();
    `);
    try {
      return await fn();
    } finally {
      await queryClient.unsafe(`
        DROP TRIGGER IF EXISTS ${PREFIX}slow_insert ON workflow_state;
        DROP FUNCTION IF EXISTS ${PREFIX}slow_insert();
      `);
    }
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL, { max: 20 });
    db = drizzle(queryClient);
    await cleanup();

    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@workflow-state.test`,
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

  beforeEach(async () => {
    await db
      .delete(workflowState)
      .where(eq(workflowState.workflowId, workflowId));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("reports a missing key with version 0", async () => {
    const result = await getWorkflowStateValue(scope, "missing", db);

    expect(result).toEqual({
      success: true,
      exists: false,
      value: null,
      version: 0,
    });
  });

  it("keeps a workflow's state when the workflow moves to another org", async () => {
    // Account linking re-parents an anonymous user's workflows to the new
    // owner's org; the cursor must survive that.
    const otherOrgId = `${PREFIX}org_other`;
    await db.insert(organization).values({
      id: otherOrgId,
      name: otherOrgId,
      slug: otherOrgId,
      createdAt: new Date(),
    });
    await setWorkflowStateValue(scope, "cursor", { value: 7 }, db);

    try {
      await db
        .update(workflows)
        .set({ organizationId: otherOrgId })
        .where(eq(workflows.id, workflowId));

      expect(await getWorkflowStateValue(scope, "cursor", db)).toMatchObject({
        exists: true,
        value: 7,
      });
    } finally {
      await db
        .update(workflows)
        .set({ organizationId: orgId })
        .where(eq(workflows.id, workflowId));
    }
  });

  it("reports a database failure without the driver's message", async () => {
    // A workflow deleted mid-run: the insert violates the workflow foreign key.
    const result = await setWorkflowStateValue(
      { workflowId: `${PREFIX}deleted_wf` },
      "cursor",
      { value: 1 },
      db
    );

    expect(result).toEqual({
      success: false,
      error: "Failed to write workflow state",
      reason: "storage",
    });
  });

  it("creates, then overwrites with a version bump", async () => {
    const first = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 1 },
      db
    );
    const second = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2 },
      db
    );

    expect(first).toEqual({ success: true, created: true, version: 1 });
    expect(second).toEqual({ success: true, created: false, version: 2 });
    expect(await getWorkflowStateValue(scope, "cursor", db)).toEqual({
      success: true,
      exists: true,
      value: 2,
      version: 2,
    });
  });

  it("applies a compare-and-set on the current version and rejects a stale one", async () => {
    await setWorkflowStateValue(scope, "cursor", { value: 1 }, db);

    const applied = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2, expectedVersion: 1 },
      db
    );
    const stale = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 3, expectedVersion: 1 },
      db
    );

    expect(applied).toEqual({ success: true, created: false, version: 2 });
    expect(stale).toMatchObject({ success: false, reason: "conflict" });
    expect(await getWorkflowStateValue(scope, "cursor", db)).toMatchObject({
      value: 2,
      version: 2,
    });
  });

  it("writes with expectedVersion 0 only while the key does not exist", async () => {
    const first = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 1, expectedVersion: 0 },
      db
    );
    const second = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2, expectedVersion: 0 },
      db
    );

    expect(first).toEqual({ success: true, created: true, version: 1 });
    expect(second).toMatchObject({ success: false, reason: "conflict" });

    // An expired key counts as missing and keeps counting its version.
    await expireKey("cursor");
    const revived = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 3, expectedVersion: 0 },
      db
    );
    expect(revived).toEqual({ success: true, created: true, version: 2 });
  });

  it("lets exactly one of two concurrent first writers win", async () => {
    // Without the lock both writers see no row before either insert lands,
    // and the conflict arm turns the second insert into a silent overwrite.
    const results = await withSlowInserts(() =>
      Promise.all(
        [1, 2].map((value) =>
          setWorkflowStateValue(
            scope,
            "cursor",
            { value, expectedVersion: 0 },
            db
          )
        )
      )
    );

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(
      results.filter((r) => !r.success && r.reason === "conflict")
    ).toHaveLength(1);
  });

  it("reports replacing an expired key as a create", async () => {
    await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 1, ttlSeconds: 60 },
      db
    );
    await expireKey("cursor");

    const result = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 2 },
      db
    );

    expect(result).toMatchObject({ success: true, created: true });
  });

  it("keeps an expired row on read so a re-created key continues its version", async () => {
    await setWorkflowStateValue(scope, "cursor", { value: 1 }, db);
    await setWorkflowStateValue(scope, "cursor", { value: 2 }, db);
    await expireKey("cursor");

    expect(await getWorkflowStateValue(scope, "cursor", db)).toMatchObject({
      exists: false,
    });
    const [kept] = await db
      .select({ version: workflowState.version })
      .from(workflowState)
      .where(
        and(
          eq(workflowState.workflowId, workflowId),
          eq(workflowState.key, "cursor")
        )
      );
    expect(kept?.version).toBe(2);

    // A holder of version 2 from before the expiry must not match the
    // re-created key.
    const recreated = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 3 },
      db
    );
    const stale = await setWorkflowStateValue(
      scope,
      "cursor",
      { value: 4, expectedVersion: 2 },
      db
    );

    expect(recreated).toEqual({ success: true, created: true, version: 3 });
    expect(stale).toMatchObject({ success: false, reason: "conflict" });
  });

  it("counts reviving an expired key against the ceiling", async () => {
    const max = WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW;
    await db.insert(workflowState).values(
      Array.from({ length: max }, (_, i) => ({
        workflowId,
        key: `seed-${i}`,
        value: i,
      }))
    );
    await expireKey("seed-0");

    // The expired key freed a slot, and a new key takes it.
    const fresh = await setWorkflowStateValue(scope, "fresh", { value: 1 }, db);
    const revived = await setWorkflowStateValue(
      scope,
      "seed-0",
      { value: 2 },
      db
    );
    const overwrite = await setWorkflowStateValue(
      scope,
      "fresh",
      { value: 3 },
      db
    );

    expect(fresh).toMatchObject({ success: true, created: true });
    expect(revived).toMatchObject({ success: false, reason: "limit" });
    expect(overwrite).toMatchObject({ success: true, created: false });
  });

  it("holds the key ceiling under concurrent new-key writers", async () => {
    const max = WORKFLOW_STATE_LIMITS.MAX_KEYS_PER_WORKFLOW;
    await db.insert(workflowState).values(
      Array.from({ length: max - 1 }, (_, i) => ({
        workflowId,
        key: `seed-${i}`,
        value: i,
      }))
    );

    // Without the per-workflow lock every writer's count runs while the
    // others' inserts are still uncommitted, all of them read 99, and the
    // workflow ends well past the ceiling.
    const writers = 10;
    const results = await withSlowInserts(() =>
      Promise.all(
        Array.from({ length: writers }, (_, i) =>
          setWorkflowStateValue(scope, `new-${i}`, { value: i }, db)
        )
      )
    );

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowState)
      .where(eq(workflowState.workflowId, workflowId));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(
      results.filter((r) => !r.success && r.reason === "limit")
    ).toHaveLength(writers - 1);
    expect(row.count).toBe(max);
  });
});
