import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  workflowExecutions,
  workflowFailureAlertQueue,
  workflows,
} from "../../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these tests must write Postgres.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = `rr_${Date.now().toString(36)}_`;
const USER_ID = `${PREFIX}user`;
const ORG_ID = `${PREFIX}org`;

type Db = typeof import("@/lib/db").db;
type Helpers = typeof import("@/lib/workflow/refused-runs");

let db: Db;
let helpers: Helpers;
let seq = 0;

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  const pattern = `${PREFIX}%`;
  try {
    await client`DELETE FROM alert_queue WHERE workflow_id LIKE ${pattern}`;
    await client`DELETE FROM workflow_executions WHERE workflow_id LIKE ${pattern}`;
    await client`DELETE FROM workflows WHERE id LIKE ${pattern}`;
    await client`DELETE FROM organization WHERE id LIKE ${pattern}`;
    await client`DELETE FROM users WHERE id LIKE ${pattern}`;
  } finally {
    await client.end();
  }
}

async function makeWorkflow(): Promise<string> {
  seq += 1;
  const id = `${PREFIX}wf${seq}`;
  await db.insert(workflows).values({
    id,
    name: id,
    userId: USER_ID,
    organizationId: ORG_ID,
    nodes: [],
    edges: [],
    enabled: true,
  });
  return id;
}

function refusal(workflowId: string, at: Date, reason = "limit reached") {
  return {
    workflowId,
    userId: USER_ID,
    organizationId: ORG_ID,
    reason,
    reasonCode: "execution_limit",
    category: "billing" as const,
    triggerSource: "webhook" as const,
    at,
  };
}

function rowsOf(workflowId: string) {
  return db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId))
    .orderBy(workflowExecutions.startedAt);
}

async function clearQueue(workflowId: string): Promise<void> {
  await db
    .delete(workflowFailureAlertQueue)
    .where(eq(workflowFailureAlertQueue.workflowId, workflowId));
}

async function queued(workflowId: string): Promise<boolean> {
  const [row] = await db
    .select({ dueAt: workflowFailureAlertQueue.dueAt })
    .from(workflowFailureAlertQueue)
    .where(eq(workflowFailureAlertQueue.workflowId, workflowId));
  return Boolean(row);
}

describe.skipIf(SKIP)("recordRefusedRun (real Postgres)", () => {
  beforeAll(async () => {
    await cleanup();
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    helpers = await import("@/lib/workflow/refused-runs");
    await db.insert(users).values({
      id: USER_ID,
      name: "refusal owner",
      email: `${PREFIX}@refused.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organization).values({
      id: ORG_ID,
      name: "Refusals",
      slug: ORG_ID.replaceAll("_", "-"),
      createdAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it("inserts one refused row with the shared shape and queues the evaluator", async () => {
    const workflowId = await makeWorkflow();
    const at = new Date("2026-11-05T10:05:00Z");
    const row = await helpers.recordRefusedRun(refusal(workflowId, at));

    expect(row?.id).toBeTruthy();
    const [stored] = await rowsOf(workflowId);
    expect(stored).toMatchObject({
      status: "skipped",
      errorCategory: "billing",
      errorType: "user",
      error: "limit reached",
      billable: false,
      triggerSource: "webhook",
      dispatchKey: `refused:${workflowId}:execution_limit:2026-11-05T10`,
      output: { refusals: 1 },
    });
    expect(stored.startedAt.toISOString()).toBe(at.toISOString());
    expect(stored.completedAt?.toISOString()).toBe(at.toISOString());
    expect(await queued(workflowId)).toBe(true);
  });

  it("folds refusals in the same hour into one row: count up, completed_at moves, queued again", async () => {
    const workflowId = await makeWorkflow();
    const first = new Date("2026-11-05T11:01:00Z");
    const last = new Date("2026-11-05T11:40:00Z");
    await helpers.recordRefusedRun(refusal(workflowId, first));
    await clearQueue(workflowId);
    await helpers.recordRefusedRun(refusal(workflowId, last, "still over"));
    await helpers.recordRefusedRun(
      refusal(workflowId, new Date("2026-11-05T11:20:00Z"))
    );

    const rows = await rowsOf(workflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0].output).toEqual({ refusals: 3 });
    expect(rows[0].startedAt.toISOString()).toBe(first.toISOString());
    // An out-of-order write never moves the last-refused time backwards.
    expect(rows[0].completedAt?.toISOString()).toBe(last.toISOString());
    expect(rows[0].status).toBe("skipped");
    // The update keeps status 'skipped', so only the helper can queue it.
    expect(await queued(workflowId)).toBe(true);
  });

  it("starts a new row in the next hour and per reason", async () => {
    const workflowId = await makeWorkflow();
    await helpers.recordRefusedRun(
      refusal(workflowId, new Date("2026-11-05T12:59:00Z"))
    );
    await helpers.recordRefusedRun(
      refusal(workflowId, new Date("2026-11-05T13:00:00Z"))
    );
    await helpers.recordRefusedRun({
      ...refusal(workflowId, new Date("2026-11-05T13:05:00Z")),
      reasonCode: "plan_feature",
    });
    expect(await rowsOf(workflowId)).toHaveLength(3);
  });

  it("counts a refused row out of billable usage", async () => {
    const workflowId = await makeWorkflow();
    await helpers.recordRefusedRun(refusal(workflowId, new Date()));
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowExecutions)
      .where(
        sql`${workflowExecutions.workflowId} = ${workflowId} AND ${workflowExecutions.billable} = true`
      );
    expect(counted.n).toBe(0);
  });

  it("markRunRefused turns a pending row into the same refused shape, once", async () => {
    const workflowId = await makeWorkflow();
    const [pending] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        organizationId: ORG_ID,
        userId: USER_ID,
        status: "pending",
        input: {},
      })
      .returning({ id: workflowExecutions.id });
    await clearQueue(workflowId);
    const at = new Date();

    const marked = await helpers.markRunRefused({
      executionId: pending.id,
      fromStatuses: ["pending"],
      reason: "Unpaid",
      category: "billing",
      at,
    });
    expect(marked).toEqual({ workflowId });
    const [stored] = await rowsOf(workflowId);
    expect(stored).toMatchObject({
      status: "skipped",
      errorCategory: "billing",
      errorType: "user",
      error: "Unpaid",
      billable: false,
      output: { refusals: 1 },
    });
    expect(await queued(workflowId)).toBe(true);

    // The compare-and-set no longer matches a skipped row.
    const again = await helpers.markRunRefused({
      executionId: pending.id,
      fromStatuses: ["pending"],
      reason: "Unpaid",
      category: "billing",
      at,
    });
    expect(again).toBeNull();
  });
});
