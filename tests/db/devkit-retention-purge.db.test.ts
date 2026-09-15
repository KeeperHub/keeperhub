/**
 * The DevKit run retention job against a real Postgres.
 *
 * The unit suite stubs the drizzle builder, so it asserts the order of the
 * deletes, not which rows the SQL selects. This file seeds the `workflow`
 * schema that @workflow/world-postgres creates and checks what actually goes:
 * finished runs past the window with every child row, and nothing else.
 *
 * Needs the DevKit schema: run `pnpm db:setup-workflow` before `pnpm db:migrate`
 * on the test database, the same order the deploy job uses.
 */

import "dotenv/config";
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

// vitest runs in Node, not an SSR context; every lib/retention module is
// server-only.
vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "wrun_test_devkit_retention_";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * DAY_MS).toISOString();

const EVENTS_PER_RUN = 3;
const STEPS_PER_RUN = 2;

/** Every run this suite reasons about, as (suffix, age in days, status). */
const RUNS: [string, number, string][] = [
  ["old_completed", 40, "completed"],
  ["old_failed", 40, "failed"],
  ["old_cancelled", 45, "cancelled"],
  ["old_running", 40, "running"],
  ["old_pending", 40, "pending"],
  ["fresh_completed", 5, "completed"],
];
const DELETED = ["old_completed", "old_failed", "old_cancelled"];
const KEPT = ["old_running", "old_pending", "fresh_completed"];

const runId = (suffix: string): string => `${PREFIX}${suffix}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    dryRun: false,
    retentionDays: 30,
    batchSize: 1000,
    maxRuntimeMs: 60_000,
    ...overrides,
  };
}

type Purge = typeof import("@/lib/retention/purge-devkit-runs");

describe("DevKit run retention (real database)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let runDevkitRetentionPurge: Purge["runDevkitRetentionPurge"];
  let selectRunBatch: Purge["selectRunBatch"];

  async function cleanup(): Promise<void> {
    const like = `${PREFIX}%`;
    await queryClient`DELETE FROM workflow.workflow_events WHERE run_id LIKE ${like}`;
    await queryClient`DELETE FROM workflow.workflow_steps WHERE run_id LIKE ${like}`;
    await queryClient`DELETE FROM workflow.workflow_runs WHERE id LIKE ${like}`;
  }

  async function seed(): Promise<void> {
    await cleanup();
    for (const [suffix, age, status] of RUNS) {
      const id = runId(suffix);
      const createdAt = daysAgo(age);
      await queryClient`
        INSERT INTO workflow.workflow_runs
          (id, deployment_id, status, name, created_at, updated_at)
        VALUES (${id}, 'test', ${status}, 'retention probe', ${createdAt}, ${createdAt})`;
      for (let i = 0; i < EVENTS_PER_RUN; i += 1) {
        await queryClient`
          INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
          VALUES (${`${id}_evt_${i}`}, 'run_created', ${id}, ${createdAt})`;
      }
      for (let i = 0; i < STEPS_PER_RUN; i += 1) {
        await queryClient`
          INSERT INTO workflow.workflow_steps
            (step_id, run_id, step_name, status, attempt, created_at, updated_at)
          VALUES (${`${id}_step_${i}`}, ${id}, 'probe', 'completed', 1, ${createdAt}, ${createdAt})`;
      }
    }
  }

  async function rowsOf(suffix: string): Promise<{
    runs: number;
    steps: number;
    events: number;
  }> {
    const id = runId(suffix);
    const [row] = await queryClient`
      SELECT
        (SELECT count(*)::int FROM workflow.workflow_runs WHERE id = ${id}) AS runs,
        (SELECT count(*)::int FROM workflow.workflow_steps WHERE run_id = ${id}) AS steps,
        (SELECT count(*)::int FROM workflow.workflow_events WHERE run_id = ${id}) AS events`;
    return { runs: row.runs, steps: row.steps, events: row.events };
  }

  const ALL_ROWS = {
    runs: 1,
    steps: STEPS_PER_RUN,
    events: EVENTS_PER_RUN,
  };
  const NO_ROWS = { runs: 0, steps: 0, events: 0 };

  beforeAll(async () => {
    // This suite deletes every finished DevKit run past the window in the
    // database, not only its own. Refuse to run anywhere but a local scratch
    // database.
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) {
      throw new Error(`refusing to run against a non-local database: ${host}`);
    }
    queryClient = postgres(DATABASE_URL);
    ({ runDevkitRetentionPurge, selectRunBatch } = await import(
      "@/lib/retention/purge-devkit-runs"
    ));
  });

  beforeEach(seed);

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("deletes finished runs past the window with all their steps and events", async () => {
    const result = await runDevkitRetentionPurge(config(), NOW);

    expect(result).toMatchObject({
      enabled: true,
      dryRun: false,
      runs: DELETED.length,
      steps: DELETED.length * STEPS_PER_RUN,
      events: DELETED.length * EVENTS_PER_RUN,
      budgetExhausted: false,
    });
    for (const suffix of DELETED) {
      expect(await rowsOf(suffix)).toEqual(NO_ROWS);
    }
  });

  it("keeps runs that can still resume and runs inside the window, with their children", async () => {
    await runDevkitRetentionPurge(config(), NOW);

    for (const suffix of KEPT) {
      expect(await rowsOf(suffix)).toEqual(ALL_ROWS);
    }
  });

  it("drains more runs than one batch holds in a single call", async () => {
    const result = await runDevkitRetentionPurge(config({ batchSize: 2 }), NOW);

    expect(result.runs).toBe(DELETED.length);
    expect(result.budgetExhausted).toBe(false);
    for (const suffix of DELETED) {
      expect(await rowsOf(suffix)).toEqual(NO_ROWS);
    }
  });

  it("stops without deleting when the budget is already spent", async () => {
    const result = await runDevkitRetentionPurge(
      config({ maxRuntimeMs: 0 }),
      NOW
    );

    expect(result).toMatchObject({ runs: 0, budgetExhausted: true });
    for (const suffix of DELETED) {
      expect(await rowsOf(suffix)).toEqual(ALL_ROWS);
    }
  });

  it("counts the eligible runs on a dry run and deletes nothing", async () => {
    const result = await runDevkitRetentionPurge(config({ dryRun: true }), NOW);

    expect(result).toMatchObject({
      dryRun: true,
      runs: DELETED.length,
      steps: 0,
      events: 0,
    });
    for (const [suffix] of RUNS) {
      expect(await rowsOf(suffix)).toEqual(ALL_ROWS);
    }
  });

  it("creates the created_at index the batch select depends on", async () => {
    const [row] =
      await queryClient`SELECT to_regclass('workflow.idx_workflow_runs_created_at') IS NOT NULL AS present`;
    expect(row.present).toBe(true);
  });

  it("plans the generated batch select on the created_at index", async () => {
    const { sql, params } = selectRunBatch(new Date(daysAgo(30)), 500).toSQL();

    // A near-empty table is cheapest to scan whole, or through the status index
    // and a sort, so the planner is told not to do either. What this proves is
    // that the generated SQL CAN be served in created_at order straight from
    // the index, which is the property the job depends on for a large table.
    const plan = await queryClient.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      await tx`SET LOCAL enable_sort = off`;
      return tx.unsafe(`EXPLAIN ${sql}`, params as never[]);
    });
    const text = plan.map((line) => line["QUERY PLAN"]).join("\n");

    expect(text).not.toContain("Seq Scan");
    expect(text).toContain("idx_workflow_runs_created_at");
  });
});
