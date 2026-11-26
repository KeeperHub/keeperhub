import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionStatus } from "../../../lib/errors/execution-status";
import { resolveSwitch } from "../../../lib/utils";
import { isSkipIfRunningSupported } from "../../../lib/workflow/block-trigger-switches";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these tests must read Postgres.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = `sir_${Date.now().toString(36)}_`;
const USER_ID = `${PREFIX}user`;
const ORG_ID = `${PREFIX}org`;

type Db = typeof import("@/lib/db").db;
type Schema = typeof import("@/lib/db/schema");
type Skip = typeof import("@/lib/workflow/skip-if-running");
type Claims = typeof import("../../../keeperhub-executor/lib/db-helpers");
let db: Db;
let schema: Schema;
let skip: Skip;
let claims: Claims;
let seq = 0;
// Fresh block numbers for probes, apart from the ones tests name.
let probeBlock = 1_000_000;

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    await client`DELETE FROM workflow_execution_logs WHERE execution_id IN (SELECT id FROM workflow_executions WHERE workflow_id LIKE ${`${PREFIX}%`})`;
    await client`DELETE FROM workflow_executions WHERE workflow_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  } finally {
    await client.end();
  }
}

/** Nodes of a workflow whose only node is a trigger with this config. */
const triggerNodes = (config: Record<string, unknown>) => [
  {
    id: "trigger",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { type: "trigger", label: "Trigger", config },
  },
];

/** A workflow with one run in `status`, started `ageMs` ago. */
async function workflowWithRun(
  status: WorkflowExecutionStatus | null,
  ageMs = 0,
  triggerSource: string | null = "block",
  nodes: unknown[] = []
): Promise<string> {
  seq += 1;
  const id = `${PREFIX}wf${seq}`;
  await db.insert(schema.workflows).values({
    id,
    name: id,
    userId: USER_ID,
    organizationId: ORG_ID,
    nodes,
    edges: [],
  });
  if (status) {
    await db.insert(schema.workflowExecutions).values({
      workflowId: id,
      userId: USER_ID,
      status,
      triggerSource,
      startedAt: new Date(Date.now() - ageMs),
    });
  }
  return id;
}

const dispatch = (
  workflowId: string,
  block: number,
  now?: Date,
  database: Db = db
) =>
  skip.insertPhantomUnlessRunning(
    database,
    {
      workflowId,
      userId: USER_ID,
      organizationId: ORG_ID,
      status: "phantom",
      dispatchKey: `block:${workflowId}:1:${block}`,
    },
    now
  );

/** Whether a new block of the workflow would be skipped (writes its phantom or Skipped row). */
const busy = async (workflowId: string): Promise<boolean> => {
  probeBlock += 1;
  return (await dispatch(workflowId, probeBlock)).skipped;
};

/** A finished step of the workflow's run, completed `ageMs` ago. */
async function stepCompleted(workflowId: string, ageMs: number): Promise<void> {
  const [run] = await rowsOf(workflowId);
  await db.insert(schema.workflowExecutionLogs).values({
    executionId: run.id,
    nodeId: "step",
    nodeName: "Step",
    nodeType: "action",
    status: "success",
    startedAt: new Date(Date.now() - ageMs - 1000),
    completedAt: new Date(Date.now() - ageMs),
  });
}

/** Marks the workflow's live runs (or the given ones) finished. */
async function finish(workflowId: string, ids?: string[]): Promise<void> {
  await db
    .update(schema.workflowExecutions)
    .set({ status: "success", completedAt: new Date() })
    .where(
      and(
        eq(schema.workflowExecutions.workflowId, workflowId),
        ids
          ? inArray(schema.workflowExecutions.id, ids)
          : inArray(schema.workflowExecutions.status, [
              "phantom",
              "pending",
              "running",
            ])
      )
    );
}

const skipRows = async (workflowId: string) =>
  (await rowsOf(workflowId)).filter((r) => r.status === "skipped");
const countOf = (row: { output: unknown }): number =>
  (row.output as { refusals: number }).refusals;
const phantomsFor = async (workflowId: string, block: number) =>
  (await rowsOf(workflowId)).filter(
    (r) =>
      r.status === "phantom" &&
      r.dispatchKey === `block:${workflowId}:1:${block}`
  );

/** Polls until a backend is waiting on the given backend's locks (no fixed sleeps). */
async function waitUntilBlockedBy(pid: number): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    for (let i = 0; i < 200; i++) {
      const [row] =
        await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
      if (row.n > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("no backend ever waited on the held transaction");
  } finally {
    await client.end();
  }
}

const rowsOf = (workflowId: string) =>
  db
    .select()
    .from(schema.workflowExecutions)
    .where(eq(schema.workflowExecutions.workflowId, workflowId))
    .orderBy(schema.workflowExecutions.startedAt);

describe.skipIf(SKIP)("skip if still running (real Postgres)", () => {
  beforeAll(async () => {
    await cleanup();
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");
    skip = await import("@/lib/workflow/skip-if-running");
    claims = await import("../../../keeperhub-executor/lib/db-helpers");
    await db.insert(schema.users).values({
      id: USER_ID,
      name: "skip owner",
      email: `${PREFIX}@skip.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.organization).values({
      id: ORG_ID,
      name: "Skip",
      slug: ORG_ID.replaceAll("_", "-"),
      createdAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup();
  });

  it.each(["phantom", "pending", "running"] as const)(
    "a %s run blocks",
    async (status) => {
      expect(await busy(await workflowWithRun(status))).toBe(true);
    }
  );

  it.each(["unconfirmed", "success", "error", "skipped"] as const)(
    "a %s run does not block",
    async (status) => {
      expect(await busy(await workflowWithRun(status))).toBe(false);
    }
  );

  it("a listed-workflow call (trigger source mcp) does not block; legacy rows without a source do", async () => {
    expect(await busy(await workflowWithRun("running", 0, "mcp"))).toBe(false);
    expect(await busy(await workflowWithRun("running", 0, null))).toBe(true);
  });

  it("a run older than the stale limit still blocks while a step completed within it", async () => {
    const workflowId = await workflowWithRun("running", 35 * 60_000);
    await stepCompleted(workflowId, 2 * 60_000);
    expect(await busy(workflowId)).toBe(true);
  });

  it("a run older than the stale limit with no step completed within it does not block", async () => {
    expect(await busy(await workflowWithRun("running", 31 * 60_000))).toBe(
      false
    );
    const stalled = await workflowWithRun("running", 40 * 60_000);
    await stepCompleted(stalled, 31 * 60_000);
    expect(await busy(stalled)).toBe(false);
    expect(await busy(await workflowWithRun("running", 29 * 60_000))).toBe(
      true
    );
    vi.stubEnv("STALE_EXECUTION_THRESHOLD_MINUTES", "10");
    expect(await busy(await workflowWithRun("running", 11 * 60_000))).toBe(
      false
    );
    vi.unstubAllEnvs();
  });

  it("finds the run still progressing behind 150 older stalled live rows", async () => {
    const workflowId = await workflowWithRun(null);
    // 150 stalled pending rows from 2 to 4.5 hours ago, then one progressing run.
    await db.insert(schema.workflowExecutions).values(
      Array.from({ length: 150 }, (_, i) => ({
        workflowId,
        userId: USER_ID,
        status: "pending" as const,
        triggerSource: "block",
        startedAt: new Date(Date.now() - (120 + i) * 60_000),
      }))
    );
    const [progressing] = await db
      .insert(schema.workflowExecutions)
      .values({
        workflowId,
        userId: USER_ID,
        status: "running",
        triggerSource: "block",
        startedAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning({ id: schema.workflowExecutions.id });
    await db.insert(schema.workflowExecutionLogs).values({
      executionId: progressing.id,
      nodeId: "step",
      nodeName: "Step",
      nodeType: "action",
      status: "success",
      startedAt: new Date(Date.now() - 61_000),
      completedAt: new Date(Date.now() - 60_000),
    });
    const result = await dispatch(workflowId, 700);
    expect(result.skipped).toBe(true);
    const [row] = await skipRows(workflowId);
    expect(row.dispatchKey).toBe(`skipped-behind:${progressing.id}`);
  });

  it("finds the run still progressing when it is older than 150 stalled live rows", async () => {
    const workflowId = await workflowWithRun(null);
    const [progressing] = await db
      .insert(schema.workflowExecutions)
      .values({
        workflowId,
        userId: USER_ID,
        status: "running",
        triggerSource: "block",
        startedAt: new Date(Date.now() - 5 * 60 * 60_000),
      })
      .returning({ id: schema.workflowExecutions.id });
    await db.insert(schema.workflowExecutionLogs).values({
      executionId: progressing.id,
      nodeId: "step",
      nodeName: "Step",
      nodeType: "action",
      status: "success",
      startedAt: new Date(Date.now() - 61_000),
      completedAt: new Date(Date.now() - 60_000),
    });
    // 150 stalled pending rows, all newer than it, from 40 minutes to 3 hours ago.
    await db.insert(schema.workflowExecutions).values(
      Array.from({ length: 150 }, (_, i) => ({
        workflowId,
        userId: USER_ID,
        status: "pending" as const,
        triggerSource: "block",
        startedAt: new Date(Date.now() - (40 + i) * 60_000),
      }))
    );
    const result = await dispatch(workflowId, 701);
    expect(result.skipped).toBe(true);
    const [row] = await skipRows(workflowId);
    expect(row.dispatchKey).toBe(`skipped-behind:${progressing.id}`);
  });

  it("the cap keeps the newest older live rows: a progressing run newer than 1,005 stalled ones is found", async () => {
    const workflowId = await workflowWithRun(null);
    // More stalled rows than the cap, all older than the progressing run.
    await db.insert(schema.workflowExecutions).values(
      Array.from({ length: 1005 }, (_, i) => ({
        workflowId,
        userId: USER_ID,
        status: "pending" as const,
        triggerSource: "block",
        startedAt: new Date(Date.now() - (120 + i) * 60_000),
      }))
    );
    const [progressing] = await db
      .insert(schema.workflowExecutions)
      .values({
        workflowId,
        userId: USER_ID,
        status: "running",
        triggerSource: "block",
        startedAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning({ id: schema.workflowExecutions.id });
    await db.insert(schema.workflowExecutionLogs).values({
      executionId: progressing.id,
      nodeId: "step",
      nodeName: "Step",
      nodeType: "action",
      status: "success",
      startedAt: new Date(Date.now() - 61_000),
      completedAt: new Date(Date.now() - 60_000),
    });
    const result = await dispatch(workflowId, 702);
    expect(result.skipped).toBe(true);
    const [row] = await skipRows(workflowId);
    expect(row.dispatchKey).toBe(`skipped-behind:${progressing.id}`);
  });

  it("a key skipped behind a run past the stale limit is still not run after it finishes", async () => {
    const workflowId = await workflowWithRun("running", 50 * 60_000);
    await stepCompleted(workflowId, 60_000);
    // The Skipped row starts 35 minutes ago, more than the stale limit before the next skip.
    const first = await dispatch(
      workflowId,
      600,
      new Date(Date.now() - 35 * 60_000)
    );
    const second = await dispatch(workflowId, 601);
    expect(second).toMatchObject({ id: first.id, skipped: true });
    await finish(workflowId);
    expect(
      await dispatch(workflowId, 601, new Date(Date.now() + 60_000))
    ).toEqual({ id: first.id, skipped: true, alreadyExisted: true });
    expect(await phantomsFor(workflowId, 601)).toHaveLength(0);
  });

  it("writes a phantom when nothing runs, then one Skipped row with a count per blocking run", async () => {
    const workflowId = await workflowWithRun(null);
    const first = await dispatch(workflowId, 1);
    expect(first).toMatchObject({ skipped: false, alreadyExisted: false });
    const second = await dispatch(workflowId, 2);
    const third = await dispatch(workflowId, 3);
    expect(second).toMatchObject({ skipped: true, alreadyExisted: false });
    expect(third.id).toBe(second.id);

    const rows = await rowsOf(workflowId);
    expect(rows.map((r) => r.status)).toEqual(["phantom", "skipped"]);
    expect(rows[1]).toMatchObject({
      billable: false,
      errorCategory: null,
      error:
        "Execution skipped: the previous run of this workflow was still running.",
      dispatchKey: `skipped-behind:${first.id}`,
    });
    const output = rows[1].output as {
      refusals: number;
      keys: Record<string, number>;
    };
    expect(output.refusals).toBe(2);
    expect(Object.keys(output.keys).sort()).toEqual([
      `block:${workflowId}:1:2`,
      `block:${workflowId}:1:3`,
    ]);
  });

  it("a repeated dispatch of one block is a duplicate, not a skip", async () => {
    const workflowId = await workflowWithRun(null);
    const first = await dispatch(workflowId, 7);
    expect(await dispatch(workflowId, 7)).toEqual({
      id: first.id,
      skipped: false,
      alreadyExisted: true,
    });
    expect(await rowsOf(workflowId)).toHaveLength(1);
  });

  it("a skipped block sent again while blocked counts once", async () => {
    const workflowId = await workflowWithRun("running");
    const skipped = await dispatch(workflowId, 20);
    expect(await dispatch(workflowId, 20)).toEqual({
      id: skipped.id,
      skipped: true,
      alreadyExisted: true,
    });
    expect(countOf((await skipRows(workflowId))[0])).toBe(1);
  });

  it("a skipped block sent again after the blocker finished starts no run", async () => {
    const workflowId = await workflowWithRun("running");
    const skipped = await dispatch(workflowId, 30);
    await finish(workflowId);
    expect(await dispatch(workflowId, 30)).toEqual({
      id: skipped.id,
      skipped: true,
      alreadyExisted: true,
    });
    expect(await phantomsFor(workflowId, 30)).toHaveLength(0);
    // A new block still runs.
    expect(await dispatch(workflowId, 31)).toMatchObject({ skipped: false });
  });

  it("finds a skipped key after more than 3 real runs since", async () => {
    const workflowId = await workflowWithRun("running");
    await dispatch(workflowId, 100);
    await finish(workflowId);
    for (const block of [101, 102, 103, 104]) {
      const run = await dispatch(workflowId, block);
      expect(run.skipped).toBe(false);
      await finish(workflowId, [run.id]);
    }
    expect(await dispatch(workflowId, 100)).toMatchObject({
      skipped: true,
      alreadyExisted: true,
    });
    expect(await phantomsFor(workflowId, 100)).toHaveLength(0);
  });

  it("finds a skipped key after marketplace calls of a listed workflow", async () => {
    const workflowId = await workflowWithRun("running");
    await dispatch(workflowId, 200);
    await finish(workflowId);
    for (let i = 1; i <= 3; i++) {
      await db.insert(schema.workflowExecutions).values({
        workflowId,
        userId: USER_ID,
        status: "success",
        triggerSource: "mcp",
        startedAt: new Date(Date.now() + i),
      });
    }
    expect(await dispatch(workflowId, 200)).toMatchObject({
      skipped: true,
      alreadyExisted: true,
    });
    expect(await phantomsFor(workflowId, 200)).toHaveLength(0);
  });

  it("keeps every key of a long block (300 skips) and never counts one twice", async () => {
    const workflowId = await workflowWithRun("running");
    for (let block = 1001; block <= 1300; block++) {
      await dispatch(workflowId, block);
    }
    expect(await dispatch(workflowId, 1001)).toMatchObject({
      skipped: true,
      alreadyExisted: true,
    });
    const [row] = await skipRows(workflowId);
    expect(countOf(row)).toBe(300);
    await finish(workflowId);
    expect(await dispatch(workflowId, 1001)).toMatchObject({
      skipped: true,
      alreadyExisted: true,
    });
    expect(await phantomsFor(workflowId, 1001)).toHaveLength(0);
  });

  it("counts a key once when the blocker changes hands", async () => {
    const workflowId = await workflowWithRun("running", 60_000);
    const skipped = await dispatch(workflowId, 300);
    // A manual run starts while the first blocker is still going.
    await db.insert(schema.workflowExecutions).values({
      workflowId,
      userId: USER_ID,
      status: "running",
      triggerSource: "manual",
      startedAt: new Date(Date.now() - 30_000),
    });
    const [first] = (await rowsOf(workflowId)).filter(
      (r) => r.triggerSource === "block" && r.status === "running"
    );
    await finish(workflowId, [first.id]);
    expect(await dispatch(workflowId, 300)).toEqual({
      id: skipped.id,
      skipped: true,
      alreadyExisted: true,
    });
    const rows = await skipRows(workflowId);
    expect(rows).toHaveLength(1);
    expect(countOf(rows[0])).toBe(1);
  });

  it("a repeat older than the lookup window is still not counted twice on the live blocker's row", async () => {
    const workflowId = await workflowWithRun("running");
    const skipped = await dispatch(workflowId, 400);
    // 4 minutes on: the lookup window no longer sees the key, the row's own key list does.
    const later = new Date(Date.now() + 4 * 60_000);
    expect(await dispatch(workflowId, 400, later)).toEqual({
      id: skipped.id,
      skipped: true,
      alreadyExisted: true,
    });
    expect(countOf((await skipRows(workflowId))[0])).toBe(1);
  });

  it("drops keys older than the repeat window when the row is next written", async () => {
    const workflowId = await workflowWithRun("running");
    await dispatch(workflowId, 500);
    await dispatch(workflowId, 501, new Date(Date.now() + 3 * 60_000));
    const [row] = await skipRows(workflowId);
    expect(countOf(row)).toBe(2);
    expect(
      Object.keys((row.output as { keys: Record<string, number> }).keys)
    ).toEqual([`block:${workflowId}:1:501`]);
  });

  it("a skip onto a row holding the full 2,048 keys stays fast and keeps the newest", async () => {
    const workflowId = await workflowWithRun("running");
    const [blocker] = await rowsOf(workflowId);
    const now = Date.now();
    const keys = Object.fromEntries(
      Array.from({ length: 2048 }, (_, i) => [
        `block:${workflowId}:1:${i}`,
        now - 60_000 + i,
      ])
    );
    await db.insert(schema.workflowExecutions).values({
      workflowId,
      userId: USER_ID,
      status: "skipped",
      billable: false,
      output: { refusals: 2048, keys },
      dispatchKey: `skipped-behind:${blocker.id}`,
      startedAt: new Date(now - 60_000),
      completedAt: new Date(now - 1000),
    });
    const started = performance.now();
    expect(await dispatch(workflowId, 5000)).toMatchObject({
      skipped: true,
      alreadyExisted: false,
    });
    expect(performance.now() - started).toBeLessThan(500);
    const [row] = await skipRows(workflowId);
    const kept = Object.keys((row.output as { keys: object }).keys);
    expect(countOf(row)).toBe(2049);
    expect(kept).toHaveLength(2048);
    expect(kept).toContain(`block:${workflowId}:1:5000`);
    expect(kept).not.toContain(`block:${workflowId}:1:0`);
  });

  it("ten concurrent dispatches give one phantom and one Skipped row counting nine", async () => {
    const workflowId = await workflowWithRun(null);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => dispatch(workflowId, 40 + i))
    );
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    const rows = await rowsOf(workflowId);
    expect(rows.map((r) => r.status).sort()).toEqual(["phantom", "skipped"]);
    expect(countOf((await skipRows(workflowId))[0])).toBe(9);
  });

  // Concurrent real calls catch a missing lock only sometimes; this holds the lock open to be sure.
  it("a dispatch waits for one holding the workflow's lock, then sees its run", async () => {
    const workflowId = await workflowWithRun(null);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holder = 0;
    let locked = (): void => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A dispatch inside an open transaction keeps the workflow's lock until it commits.
    const first = db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`
      );
      holder = pid;
      const own = await dispatch(
        workflowId,
        59,
        undefined,
        tx as unknown as Db
      );
      expect(own.skipped).toBe(false);
      locked();
      await held;
    });
    await lockTaken;
    const second = dispatch(workflowId, 60);
    await waitUntilBlockedBy(holder);
    release();
    await first;
    expect((await second).skipped).toBe(true);
  });

  it("a concurrent unflagged insert of the same key reads as a duplicate, not an error", async () => {
    const workflowId = await workflowWithRun(null);
    const key = `block:${workflowId}:1:50`;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holder = 0;
    let otherId = "";
    let inserted = (): void => undefined;
    const rowWritten = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // The plain (unflagged) route path, holding its uncommitted row.
    const other = db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`
      );
      holder = pid;
      const [row] = await tx
        .insert(schema.workflowExecutions)
        .values({
          workflowId,
          userId: USER_ID,
          status: "phantom",
          dispatchKey: key,
        })
        .returning({ id: schema.workflowExecutions.id });
      otherId = row.id;
      inserted();
      await held;
    });
    await rowWritten;
    const flagged = dispatch(workflowId, 50);
    await waitUntilBlockedBy(holder);
    release();
    await other;
    expect(await flagged).toEqual({
      id: otherId,
      skipped: false,
      alreadyExisted: true,
    });
  });

  it("moves a Skipped row's completed_at at most once a minute, still recording every key", async () => {
    const workflowId = await workflowWithRun("running");
    const t0 = Date.now();
    await dispatch(workflowId, 700, new Date(t0));
    await dispatch(workflowId, 701, new Date(t0 + 30_000));
    let [row] = await skipRows(workflowId);
    expect(row.completedAt?.getTime()).toBe(t0);
    expect(countOf(row)).toBe(2);
    expect(Object.keys((row.output as { keys: object }).keys).sort()).toEqual([
      `block:${workflowId}:1:700`,
      `block:${workflowId}:1:701`,
    ]);
    await dispatch(workflowId, 702, new Date(t0 + 61_000));
    [row] = await skipRows(workflowId);
    expect(row.completedAt?.getTime()).toBe(t0 + 61_000);
    expect(countOf(row)).toBe(3);
  });

  it("a repeat of a key written while completed_at was held back neither runs nor counts", async () => {
    const workflowId = await workflowWithRun("running");
    const t0 = Date.now();
    const skipped = await dispatch(workflowId, 800, new Date(t0));
    // completed_at stays at t0 while key 801 is added 50 s later.
    await dispatch(workflowId, 801, new Date(t0 + 50_000));
    await finish(workflowId);
    // 110 s after key 801, 160 s after the row's completed_at.
    expect(await dispatch(workflowId, 801, new Date(t0 + 160_000))).toEqual({
      id: skipped.id,
      skipped: true,
      alreadyExisted: true,
    });
    expect(await phantomsFor(workflowId, 801)).toHaveLength(0);
    expect(countOf((await skipRows(workflowId))[0])).toBe(2);
  });

  describe("a phantom the reaper timed out (P-0005)", () => {
    const claim = (id: string) =>
      claims.claimPhantomForExecution(
        db as unknown as Parameters<Claims["claimPhantomForExecution"]>[0],
        id,
        {},
        "hash"
      );

    async function reapedPhantom(nodes: unknown[]): Promise<string> {
      const workflowId = await workflowWithRun(
        "system_error",
        0,
        "block",
        nodes
      );
      const [run] = await rowsOf(workflowId);
      await db
        .update(schema.workflowExecutions)
        .set({ errorCode: "P-0005", completedAt: new Date() })
        .where(eq(schema.workflowExecutions.id, run.id));
      return run.id;
    }

    it.each([true, "true"])(
      "is not claimed again when skip-if-running is %j",
      async (value) => {
        const id = await reapedPhantom(
          triggerNodes({ triggerType: "Block", skipIfRunning: value })
        );
        expect(await claim(id)).toBe("already_advanced");
        const [row] = await db
          .select()
          .from(schema.workflowExecutions)
          .where(eq(schema.workflowExecutions.id, id));
        expect(row).toMatchObject({
          status: "system_error",
          errorCode: "P-0005",
        });
      }
    );

    it.each([
      ["no trigger", []],
      [
        "the switch off",
        triggerNodes({ triggerType: "Block", skipIfRunning: false }),
      ],
      [
        "a leftover flag on a Schedule trigger",
        triggerNodes({ triggerType: "Schedule", skipIfRunning: true }),
      ],
    ])("is still claimed with %s", async (_label, nodes) => {
      expect(await claim(await reapedPhantom(nodes))).toBe("claimed");
    });

    // The executor's jsonpath, the app's resolveSwitch and the dispatcher read one switch.
    it.each([true, "true", false, "false", "TRUE", 1, "1", "yes", null])(
      "reads skip-if-running %j as resolveSwitch does",
      async (value) => {
        const on = resolveSwitch(value, false) === true;
        const id = await reapedPhantom(
          triggerNodes({
            triggerType: "Block",
            network: "1",
            skipIfRunning: value,
          })
        );
        expect(await claim(id)).toBe(on ? "already_advanced" : "claimed");
      }
    );

    it.each(["101", 103])(
      "ignores the switch on Solana network %j, as the dispatcher does",
      async (network) => {
        expect(isSkipIfRunningSupported(network)).toBe(false);
        const id = await reapedPhantom(
          triggerNodes({ triggerType: "Block", network, skipIfRunning: true })
        );
        expect(await claim(id)).toBe("claimed");
      }
    );

    it("a live phantom of a skip-flagged workflow is claimed as usual", async () => {
      const workflowId = await workflowWithRun(
        "phantom",
        0,
        "block",
        triggerNodes({ triggerType: "Block", skipIfRunning: true })
      );
      const [run] = await rowsOf(workflowId);
      expect(await claim(run.id)).toBe("claimed");
    });
  });
});
