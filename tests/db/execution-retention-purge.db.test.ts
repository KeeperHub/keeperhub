/**
 * KEEP-1042: the retention purge against a real Postgres.
 *
 * The unit suite stubs the drizzle builder, so it asserts which passes run and
 * in what order, not which rows the SQL selects. Every defect this file guards
 * was invisible there and had to be found by hand in a PR environment: a
 * watermark that advanced past rows the status guard skipped, a dry run capped
 * at one page, and a `NOT IN` that a single NULL would turn into a permanent
 * no-op.
 *
 * The database must be exclusively this file's. resolveOrgRetentionWindows
 * selects EVERY organization and the backstop pass takes the longest window
 * among them, so a seeded or shared database makes floorDays and the per-window
 * organization counts unassertable.
 */

import "dotenv/config";
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
import {
  executionRetentionProgress,
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";
import {
  organizationSubscriptions,
  paygPayments,
} from "../../lib/db/schema-extensions";
import { workflowPayments } from "../../lib/db/schema-payments";

// vitest runs in Node, not an SSR context; every lib/retention module is
// server-only.
vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_retention_";
const ORG_NONE = `${PREFIX}org_none`; // no subscription row -> 7, the prod majority
const ORG_PRO = `${PREFIX}org_pro`; // pro -> 30
const ORG_OVERRIDE = `${PREFIX}org_override`; // free + override -> 90
const ORG_CLAMPED = `${PREFIX}org_clamped`; // override below the floor -> 7
const ORG_ENT = `${PREFIX}org_ent`; // enterprise -> 365, sits at the backstop
const ORG_SECOND = `${PREFIX}org_second`; // a second 7-day org, for the budget case
const ALL_ORGS = [
  ORG_NONE,
  ORG_PRO,
  ORG_OVERRIDE,
  ORG_CLAMPED,
  ORG_ENT,
  ORG_SECOND,
];

const USER = `${PREFIX}user`;
const NOW = new Date("2026-09-09T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

/**
 * Injected rather than read from the environment. runRetentionPurge takes both
 * the config and `now` as parameters, so the suite never touches process.env
 * and never depends on the wall clock.
 */
function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    executionsEnabled: false,
    dryRun: false,
    defaultLogRetentionDays: 7,
    minLogRetentionDays: 7,
    executionLogFloorRetentionDays: 400,
    outputRawRetentionDays: 7,
    executionRetentionDays: 400,
    softDeleteGraceDays: 30,
    batchSize: 1000,
    maxRuntimeMs: 60_000,
    planChangeGraceMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

type Purge = typeof import("@/lib/retention/purge-executions");
type Progress = typeof import("@/lib/retention/progress");

describe("execution retention purge (real database)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let runRetentionPurge: Purge["runRetentionPurge"];
  let getOrgLogRetentionCutoff: Progress["getOrgLogRetentionCutoff"];

  async function cleanup(): Promise<void> {
    const like = `${PREFIX}%`;
    // Children first: every foreign key into workflow_executions is ON DELETE
    // NO ACTION, so a parent delete with a surviving child simply fails.
    await queryClient`DELETE FROM workflow_execution_logs WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM payg_payments WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflow_payments WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM execution_retention_progress WHERE organization_id LIKE ${like}`;
    await queryClient`DELETE FROM organization_subscriptions WHERE organization_id LIKE ${like}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${like}`;
  }

  /** Every run this suite reasons about, as (id, age in days, status). */
  const RUNS: [string, string, number, string][] = [
    // org, suffix, age, status
    [ORG_NONE, "fresh", 3, "success"],
    [ORG_NONE, "old", 40, "success"],
    [ORG_NONE, "phantom", 40, "phantom"],
    [ORG_PRO, "inside", 20, "success"],
    [ORG_PRO, "old", 45, "success"],
    [ORG_OVERRIDE, "inside", 60, "success"],
    [ORG_OVERRIDE, "old", 100, "success"],
    [ORG_CLAMPED, "old", 20, "success"],
    [ORG_ENT, "inside", 100, "success"],
    [ORG_ENT, "past_floor", 410, "success"],
    [ORG_ENT, "past_floor_running", 410, "running"],
    [ORG_SECOND, "old", 40, "success"],
  ];
  const runId = (org: string, suffix: string) => `${org}_run_${suffix}`;
  const logId = (org: string, suffix: string) => `${org}_log_${suffix}`;

  async function seed(): Promise<void> {
    await cleanup();
    await db.insert(users).values({
      id: USER,
      name: "retention probe",
      email: `${PREFIX}probe@keeperhub.test`,
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(organization).values(
      ALL_ORGS.map((id) => ({
        id,
        name: id,
        slug: id,
        createdAt: daysAgo(600),
      }))
    );
    // ORG_NONE and ORG_SECOND deliberately get no row: that is the state most
    // production organizations are in, and it must resolve to the default.
    await db.insert(organizationSubscriptions).values([
      { id: `${ORG_PRO}_sub`, organizationId: ORG_PRO, plan: "pro" },
      { id: `${ORG_ENT}_sub`, organizationId: ORG_ENT, plan: "enterprise" },
      {
        id: `${ORG_OVERRIDE}_sub`,
        organizationId: ORG_OVERRIDE,
        plan: "free",
        planOverrides: { logRetentionDays: 90 },
      },
      {
        id: `${ORG_CLAMPED}_sub`,
        organizationId: ORG_CLAMPED,
        plan: "free",
        // Below minLogRetentionDays: a bad override must not delete fresh data.
        planOverrides: { logRetentionDays: 3 },
      },
    ]);
    // Subscription rows otherwise take now() for updated_at, which is later
    // than this suite's fixed clock and would put every paid organization
    // inside the plan-change grace.
    await queryClient`UPDATE organization_subscriptions
                         SET updated_at = ${daysAgo(600).toISOString()},
                             created_at = ${daysAgo(600).toISOString()}
                       WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await db.insert(workflows).values(
      ALL_ORGS.map((org) => ({
        id: `${org}_wf`,
        name: `${org} workflow`,
        userId: USER,
        organizationId: org,
        nodes: [],
        edges: [],
        createdAt: daysAgo(600),
        updatedAt: daysAgo(600),
      }))
    );
    await db.insert(workflowExecutions).values(
      RUNS.map(([org, suffix, age, status]) => ({
        id: runId(org, suffix),
        workflowId: `${org}_wf`,
        organizationId: org,
        userId: USER,
        status: status as "success",
        startedAt: daysAgo(age),
        gasUsedWei: "21000000000000",
      }))
    );
    await db.insert(workflowExecutionLogs).values(
      RUNS.map(([org, suffix, age]) => ({
        id: logId(org, suffix),
        executionId: runId(org, suffix),
        nodeId: "action-1",
        nodeName: "HTTP Request",
        nodeType: "action",
        status: "success" as const,
        output: { sponsored: "true" },
        outputRaw: { sponsored: "true", secret: "hunter2" },
        startedAt: daysAgo(age),
        timestamp: daysAgo(age),
        network: "1",
      }))
    );
    // Soft-deleted logs on a fresh run, so only the grace period decides them.
    await db.insert(workflowExecutionLogs).values([
      {
        id: `${PREFIX}softdel_past_grace`,
        executionId: runId(ORG_ENT, "inside"),
        nodeId: "a",
        nodeName: "a",
        nodeType: "action",
        status: "success" as const,
        startedAt: daysAgo(2),
        timestamp: daysAgo(2),
        deletedAt: daysAgo(40),
      },
      {
        id: `${PREFIX}softdel_in_grace`,
        executionId: runId(ORG_ENT, "inside"),
        nodeId: "b",
        nodeName: "b",
        nodeType: "action",
        status: "success" as const,
        startedAt: daysAgo(2),
        timestamp: daysAgo(2),
        deletedAt: daysAgo(5),
      },
    ]);
  }

  async function logExists(id: string): Promise<boolean> {
    const rows =
      await queryClient`SELECT 1 FROM workflow_execution_logs WHERE id = ${id}`;
    return rows.length > 0;
  }

  async function outputRawOf(id: string): Promise<unknown> {
    const rows =
      await queryClient`SELECT output_raw FROM workflow_execution_logs WHERE id = ${id}`;
    return rows[0]?.output_raw ?? null;
  }

  // Read through drizzle, not the raw client: the column is `timestamp without
  // time zone` and comes back as a string otherwise.
  async function watermarkOf(org: string): Promise<Date | null> {
    const rows = await db
      .select({
        through: executionRetentionProgress.executionsPurgedThrough,
      })
      .from(executionRetentionProgress)
      .where(eq(executionRetentionProgress.organizationId, org));
    return rows[0]?.through ?? null;
  }

  beforeAll(async () => {
    // This suite deletes rows by age across every organization. Refuse to run
    // anywhere but a local scratch database, the same instinct as
    // scripts/seed/dev-bootstrap.ts.
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) {
      throw new Error(`refusing to run against a non-local database: ${host}`);
    }
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    ({ runRetentionPurge } = await import("@/lib/retention/purge-executions"));
    ({ getOrgLogRetentionCutoff } = await import("@/lib/retention/progress"));
  });

  beforeEach(seed);

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("runs the backstop at the longest window in use, not at the ceiling", async () => {
    const result = await runRetentionPurge(config(), NOW);
    // 365 (enterprise) rather than the configured 400: the ceiling caps the
    // backstop, it does not set it.
    expect(result.floorDays).toBe(365);
    expect(await logExists(logId(ORG_ENT, "past_floor"))).toBe(false);
    // The backstop carries no resumable guard on purpose - that is what stops a
    // permanently-stuck run leaking forever.
    expect(await logExists(logId(ORG_ENT, "past_floor_running"))).toBe(false);
    expect(await logExists(logId(ORG_ENT, "inside"))).toBe(true);
  });

  it("cuts each organization at the window its plan sells", async () => {
    await runRetentionPurge(config(), NOW);

    expect(await logExists(logId(ORG_NONE, "old"))).toBe(false); // 40d, 7d window
    expect(await logExists(logId(ORG_NONE, "fresh"))).toBe(true); // 3d
    expect(await logExists(logId(ORG_PRO, "old"))).toBe(false); // 45d, 30d
    expect(await logExists(logId(ORG_PRO, "inside"))).toBe(true); // 20d
    expect(await logExists(logId(ORG_OVERRIDE, "old"))).toBe(false); // 100d, 90d
    expect(await logExists(logId(ORG_OVERRIDE, "inside"))).toBe(true); // 60d
    // The override is below the configured minimum, so it is clamped up to 7
    // rather than deleting three-day-old data.
    expect(await logExists(logId(ORG_CLAMPED, "old"))).toBe(false); // 20d > 7
  });

  it("reports the organization count and rows for each window", async () => {
    const result = await runRetentionPurge(config(), NOW);
    const windows = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    )?.windows;

    // ORG_ENT is at the backstop, so it is in no group at all.
    expect(windows?.map((w) => w.retentionDays)).toEqual([7, 30, 90]);
    expect(windows?.find((w) => w.retentionDays === 7)?.organizationCount).toBe(
      3
    ); // none, clamped, second
  });

  it("leaves a run that can still resume, and comes back for it later", async () => {
    // The defect this file exists for. The plan-window pass skips a run that
    // can still resume, and used to advance the watermark past it anyway --
    // and the lower bound is inclusive, so the row was unreachable for good.
    await runRetentionPurge(config(), NOW);
    expect(await logExists(logId(ORG_NONE, "phantom"))).toBe(true);
    expect(await watermarkOf(ORG_NONE)).toEqual(daysAgo(40));

    await queryClient`UPDATE workflow_executions SET status = 'success' WHERE id = ${runId(ORG_NONE, "phantom")}`;
    await runRetentionPurge(config(), NOW);

    expect(await logExists(logId(ORG_NONE, "phantom"))).toBe(false);
  });

  it("advances to the cutoff when it skipped nothing", async () => {
    await runRetentionPurge(config(), NOW);
    expect(await watermarkOf(ORG_PRO)).toEqual(daysAgo(30));
  });

  it("gives an organization served only by the backstop a watermark too", async () => {
    await runRetentionPurge(config(), NOW);
    // ORG_ENT never enters the per-organization pass, so before the backstop
    // recorded its own cutoff this organization had no watermark at all and
    // the analytics layer could say nothing about it.
    expect(await watermarkOf(ORG_ENT)).toEqual(daysAgo(365));
  });

  it("nulls output_raw past its window and keeps output", async () => {
    await runRetentionPurge(config(), NOW);

    // ORG_ENT keeps its logs for a year, so this row survives to be stripped.
    expect(await outputRawOf(logId(ORG_ENT, "inside"))).toBeNull();
    const rows =
      await queryClient`SELECT output FROM workflow_execution_logs WHERE id = ${logId(ORG_ENT, "inside")}`;
    expect(rows[0].output).toEqual({ sponsored: "true" });
  });

  it("never strips output_raw from a run that can still resume", async () => {
    // It is the executor's authoritative resume input.
    await runRetentionPurge(config(), NOW);
    await runRetentionPurge(config(), NOW);
    expect(await outputRawOf(logId(ORG_NONE, "phantom"))).not.toBeNull();
  });

  it("hard-deletes a purged log only after its grace period", async () => {
    await runRetentionPurge(config(), NOW);
    expect(await logExists(`${PREFIX}softdel_past_grace`)).toBe(false);
    expect(await logExists(`${PREFIX}softdel_in_grace`)).toBe(true);
  });

  it("leaves an organization alone for a day after its plan changes", async () => {
    // A lapsed Pro plan: the row was just rewritten, so its 45-day log must
    // survive this run even though the pro window would take it.
    await queryClient`UPDATE organization_subscriptions
                         SET updated_at = ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString()}
                       WHERE organization_id = ${ORG_PRO}`;

    const first = await runRetentionPurge(config(), NOW);
    expect(await logExists(logId(ORG_PRO, "old"))).toBe(true);
    expect(
      first.passes.find((pass) => pass.pass === "logs_plan_window")
        ?.deferredOrganizations
    ).toBe(1);

    // Once the grace has passed, the pass catches up from its watermark.
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await runRetentionPurge(config(), later);
    expect(await logExists(logId(ORG_PRO, "old"))).toBe(false);
  });

  it("does nothing at all on a second run", async () => {
    await runRetentionPurge(config(), NOW);
    const second = await runRetentionPurge(config(), NOW);
    expect(second.totalRows).toBe(0);
    for (const pass of second.passes) {
      expect(pass.budgetExhausted).toBe(false);
    }
  });

  it("walks every eligible row in a dry run and writes nothing", async () => {
    // A 7-day run older than the floor. The floor pass owns it; a dry run moves
    // no watermark, so without the floor clamp the plan-window pass would count
    // it a second time and the dry figure would not match the real one.
    await db.insert(workflowExecutions).values({
      id: runId(ORG_NONE, "past_floor"),
      workflowId: `${ORG_NONE}_wf`,
      organizationId: ORG_NONE,
      userId: USER,
      status: "success",
      startedAt: daysAgo(400),
    });
    await db.insert(workflowExecutionLogs).values({
      id: logId(ORG_NONE, "past_floor"),
      executionId: runId(ORG_NONE, "past_floor"),
      nodeId: "action-1",
      nodeName: "HTTP Request",
      nodeType: "action",
      status: "success" as const,
      startedAt: daysAgo(400),
      timestamp: daysAgo(400),
    });

    // One row per page, so the walk has to follow the cursor across many pages
    // without a single write moving anything out of its way.
    const dry = await runRetentionPurge(
      config({ dryRun: true, batchSize: 1 }),
      NOW
    );

    expect(await logExists(logId(ORG_NONE, "old"))).toBe(true);
    expect(await watermarkOf(ORG_NONE)).toBeNull();

    // The same pages, written this time. The floor and plan-window figures
    // must match; output_raw can only be lower for real, because the passes
    // before it delete some of the rows the dry run still saw.
    const real = await runRetentionPurge(config({ batchSize: 1 }), NOW);
    const rowsOf = (result: typeof real, name: string): number | undefined =>
      result.passes.find((p) => p.pass === name)?.rows;
    expect(rowsOf(dry, "logs_floor")).toBe(rowsOf(real, "logs_floor"));
    expect(rowsOf(dry, "logs_plan_window")).toBe(
      rowsOf(real, "logs_plan_window")
    );
    expect(rowsOf(dry, "output_raw")).toBeGreaterThanOrEqual(
      rowsOf(real, "output_raw") ?? 0
    );
  });

  it("moves past a row whose timestamp carries microseconds", async () => {
    // Postgres keeps microseconds and a JS Date keeps milliseconds. A cursor
    // rounded to the millisecond sits before its own row, so with one row per
    // page the same row comes back forever. The seed writes whole
    // milliseconds, so give every row a sub-millisecond part the way now() does.
    const like = `${PREFIX}%`;
    await queryClient`
      UPDATE workflow_execution_logs
      SET started_at = started_at + interval '123456 microseconds',
          deleted_at = deleted_at + interval '123456 microseconds'
      WHERE id LIKE ${like}`;
    await queryClient`
      UPDATE workflow_executions
      SET started_at = started_at + interval '123456 microseconds'
      WHERE id LIKE ${like}`;

    const unfinished = (
      result: Awaited<ReturnType<typeof runRetentionPurge>>
    ) =>
      result.passes.filter((pass) => pass.budgetExhausted).map((p) => p.pass);

    const dry = await runRetentionPurge(
      config({ dryRun: true, batchSize: 1, maxRuntimeMs: 2000 }),
      NOW
    );
    expect(unfinished(dry)).toEqual([]);

    const real = await runRetentionPurge(
      config({ batchSize: 1, maxRuntimeMs: 2000 }),
      NOW
    );
    expect(unfinished(real)).toEqual([]);
    expect(real.passes.find((p) => p.pass === "logs_plan_window")?.rows).toBe(
      dry.passes.find((p) => p.pass === "logs_plan_window")?.rows
    );
    expect(await logExists(logId(ORG_NONE, "old"))).toBe(false);
  });

  it("flags a dry run the budget stopped as unfinished, and writes nothing", async () => {
    // What replaced the full-table count: the figure covers only the pages the
    // walk reached, and the report says so instead of scanning to make it exact.
    const result = await runRetentionPurge(
      config({ dryRun: true, maxRuntimeMs: 0 }),
      NOW
    );

    expect(result.passes[0]).toMatchObject({
      pass: "logs_floor",
      rows: 0,
      budgetExhausted: true,
    });
    expect(await logExists(logId(ORG_ENT, "past_floor"))).toBe(true);
  });

  it("drains across iterations when the batch is smaller than the work", async () => {
    // batchSize 1 is one step log per page and one run per plan-window page.
    await runRetentionPurge(config({ batchSize: 1 }), NOW);
    expect(await logExists(logId(ORG_NONE, "old"))).toBe(false);
    expect(await logExists(logId(ORG_PRO, "old"))).toBe(false);
    expect(await logExists(logId(ORG_OVERRIDE, "old"))).toBe(false);
    // The cursor walks past the run it has to skip, and the watermark still
    // stops at it.
    expect(await logExists(logId(ORG_NONE, "phantom"))).toBe(true);
    expect(await watermarkOf(ORG_NONE)).toEqual(daysAgo(40));
  });

  it("reports what a pass removed before a page failed, and stops the run", async () => {
    // A database error partway through a pass, the way the statement timeout
    // hit staging. The trigger fails the update of one row; with one row per
    // page, the two pages before it have committed.
    const target = logId(ORG_PRO, "inside");
    await queryClient.unsafe(`
      CREATE OR REPLACE FUNCTION test_retention_fail_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${target}' THEN
          RAISE EXCEPTION 'simulated statement timeout';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await queryClient.unsafe(`
      CREATE TRIGGER test_retention_fail_update
      BEFORE UPDATE OF output_raw ON workflow_execution_logs
      FOR EACH ROW EXECUTE FUNCTION test_retention_fail_update()`);

    try {
      const result = await runRetentionPurge(config({ batchSize: 1 }), NOW);
      const outputRaw = result.passes.find(
        (pass) => pass.pass === "output_raw"
      );

      expect(result.failedPass).toBe("output_raw");
      expect(outputRaw?.error).toContain("simulated statement timeout");
      // Oldest first: the enterprise log (100 days) and the override log (60
      // days) were nulled before the pro log (20 days) failed.
      expect(outputRaw?.rows).toBe(2);
      expect(await outputRawOf(logId(ORG_ENT, "inside"))).toBeNull();
      expect(await outputRawOf(logId(ORG_OVERRIDE, "inside"))).toBeNull();
      expect(await outputRawOf(target)).not.toBeNull();
      // The run stopped at the failed pass.
      expect(result.passes.at(-1)?.pass).toBe("output_raw");
      expect(await logExists(`${PREFIX}softdel_past_grace`)).toBe(true);
    } finally {
      await queryClient.unsafe(
        "DROP TRIGGER IF EXISTS test_retention_fail_update ON workflow_execution_logs"
      );
      await queryClient.unsafe(
        "DROP FUNCTION IF EXISTS test_retention_fail_update()"
      );
    }
  });

  it("records how far the plan-window walk got when a page fails, then continues", async () => {
    // The 7-day window walks every run from the floor cutoff up, one run per
    // page. A 10-day run of ORG_SECOND fails its delete. The last run handled
    // before it is at 20 days, and ORG_NONE's phantom run sits below that at 40.
    // Every run timestamp carries microseconds, so the recorded instants have
    // to round down to the millisecond.
    await db.insert(workflowExecutions).values({
      id: runId(ORG_SECOND, "late"),
      workflowId: `${ORG_SECOND}_wf`,
      organizationId: ORG_SECOND,
      userId: USER,
      status: "success",
      startedAt: daysAgo(10),
    });
    await db.insert(workflowExecutionLogs).values({
      id: logId(ORG_SECOND, "late"),
      executionId: runId(ORG_SECOND, "late"),
      nodeId: "action-1",
      nodeName: "HTTP Request",
      nodeType: "action",
      status: "success" as const,
      startedAt: daysAgo(10),
      timestamp: daysAgo(10),
    });
    const like = `${PREFIX}%`;
    await queryClient`
      UPDATE workflow_executions
      SET started_at = started_at + interval '123456 microseconds'
      WHERE id LIKE ${like}`;
    const shifted = (days: number): Date =>
      new Date(daysAgo(days).getTime() + 123);

    const target = logId(ORG_SECOND, "late");
    await queryClient.unsafe(`
      CREATE OR REPLACE FUNCTION test_retention_fail_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = '${target}' THEN
          RAISE EXCEPTION 'simulated statement timeout';
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await queryClient.unsafe(`
      CREATE TRIGGER test_retention_fail_delete
      BEFORE DELETE ON workflow_execution_logs
      FOR EACH ROW EXECUTE FUNCTION test_retention_fail_delete()`);

    try {
      const result = await runRetentionPurge(config({ batchSize: 10 }), NOW);
      const planPass = result.passes.find(
        (pass) => pass.pass === "logs_plan_window"
      );

      expect(result.failedPass).toBe("logs_plan_window");
      expect(planPass?.error).toContain("simulated statement timeout");
      expect(planPass?.rows).toBe(3);
      expect(await logExists(logId(ORG_NONE, "old"))).toBe(false);
      expect(await logExists(logId(ORG_SECOND, "old"))).toBe(false);
      expect(await logExists(logId(ORG_CLAMPED, "old"))).toBe(false);
      expect(await logExists(target)).toBe(true);
      // Progress stops at the last run handled, for every organization in the
      // window, and ORG_NONE stays at its phantom run below that.
      expect(await watermarkOf(ORG_CLAMPED)).toEqual(shifted(20));
      expect(await watermarkOf(ORG_SECOND)).toEqual(shifted(20));
      expect(await watermarkOf(ORG_NONE)).toEqual(shifted(40));
    } finally {
      await queryClient.unsafe(
        "DROP TRIGGER IF EXISTS test_retention_fail_delete ON workflow_execution_logs"
      );
      await queryClient.unsafe(
        "DROP FUNCTION IF EXISTS test_retention_fail_delete()"
      );
    }

    // The next run continues from there and finishes the window. ORG_NONE is
    // now behind the front with nothing to delete, and keeps its pin.
    await runRetentionPurge(config({ batchSize: 10 }), NOW);
    expect(await logExists(target)).toBe(false);
    expect(await watermarkOf(ORG_SECOND)).toEqual(daysAgo(7));
    expect(await watermarkOf(ORG_NONE)).toEqual(shifted(40));
    expect(await logExists(logId(ORG_NONE, "phantom"))).toBe(true);
  });

  it("catches up an organization left behind, starting where its own work is", async () => {
    // ORG_SECOND is deferred on the first run, so it keeps the floor cutoff
    // while the rest of the 7-day window moves up. On the next run it is behind
    // the window's front and gets probed: its 40-day run still has step logs.
    // ORG_NONE is behind too, held by its phantom run, with nothing to delete.
    const twoHoursBefore = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    await db.insert(organizationSubscriptions).values({
      id: `${ORG_SECOND}_sub`,
      organizationId: ORG_SECOND,
      plan: "free",
    });
    await queryClient`UPDATE organization_subscriptions
                         SET updated_at = ${twoHoursBefore.toISOString()},
                             created_at = ${daysAgo(600).toISOString()}
                       WHERE organization_id = ${ORG_SECOND}`;

    const first = await runRetentionPurge(config(), NOW);
    expect(
      first.passes.find((pass) => pass.pass === "logs_plan_window")
        ?.deferredOrganizations
    ).toBe(1);
    expect(await logExists(logId(ORG_SECOND, "old"))).toBe(true);
    expect(await watermarkOf(ORG_CLAMPED)).toEqual(daysAgo(7));

    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await runRetentionPurge(config(), later);

    expect(await logExists(logId(ORG_SECOND, "old"))).toBe(false);
    expect(await watermarkOf(ORG_SECOND)).toEqual(
      new Date(later.getTime() - 7 * DAY_MS)
    );
    expect(await watermarkOf(ORG_NONE)).toEqual(daysAgo(40));
    expect(await logExists(logId(ORG_NONE, "phantom"))).toBe(true);
  });

  it("writes no watermark when the budget stops the run", async () => {
    const result = await runRetentionPurge(config({ maxRuntimeMs: 0 }), NOW);
    expect(result.passes.every((pass) => pass.rows === 0)).toBe(true);
    for (const org of ALL_ORGS) {
      expect(await watermarkOf(org)).toBeNull();
    }
  });

  it("reports no cutoff while the job is disabled or dry", async () => {
    await runRetentionPurge(config(), NOW);
    // A real run happened, so a watermark exists -- but a reader must still be
    // told nothing while the switches say nothing is being removed. Production
    // ships disabled and staging ships dry.
    expect(
      await getOrgLogRetentionCutoff(ORG_NONE, config({ enabled: false }))
    ).toBeNull();
    expect(
      await getOrgLogRetentionCutoff(ORG_NONE, config({ dryRun: true }))
    ).toBeNull();
    expect(await getOrgLogRetentionCutoff(ORG_NONE, config())).toEqual(
      daysAgo(40)
    );
  });

  it("never claims a cutoff past what is actually gone", async () => {
    // The invariant that ties the reported instant to the rows. It fails if
    // the cutoff over-claims OR if the purge leaves something behind under it.
    await runRetentionPurge(config(), NOW);
    for (const org of ALL_ORGS) {
      const cutoff = await getOrgLogRetentionCutoff(org, config());
      if (!cutoff) {
        continue;
      }
      const rows = await queryClient`
        SELECT count(*)::int AS n
          FROM workflow_execution_logs l
          JOIN workflow_executions e ON e.id = l.execution_id
          JOIN workflows w ON w.id = e.workflow_id
         WHERE w.organization_id = ${org}
           AND e.started_at < ${cutoff.toISOString()}`;
      expect({ org, surviving: rows[0].n }).toEqual({ org, surviving: 0 });
    }
  });

  describe("run rows", () => {
    beforeEach(async () => {
      // A run past the flat window that somebody paid for, and one calldata-only
      // sale with no execution at all. That NULL is why the pass filters the
      // subquery: one NULL makes NOT IN answer NULL for every candidate and the
      // whole pass a silent no-op.
      await db.insert(workflowExecutions).values({
        id: `${PREFIX}paid_500`,
        workflowId: `${ORG_NONE}_wf`,
        organizationId: ORG_NONE,
        userId: USER,
        status: "success",
        startedAt: daysAgo(500),
      });
      await db.insert(workflowExecutions).values({
        id: `${PREFIX}unpaid_500`,
        workflowId: `${ORG_NONE}_wf`,
        organizationId: ORG_NONE,
        userId: USER,
        status: "success",
        startedAt: daysAgo(500),
      });
      await db.insert(paygPayments).values({
        id: `${PREFIX}payg`,
        organizationId: ORG_NONE,
        executionId: `${PREFIX}paid_500`,
        amountRaw: "1000",
        chainId: 1,
        payerAddress: "0x1",
        treasuryAddress: "0x2",
      });
      await db.insert(workflowPayments).values({
        id: `${PREFIX}calldata_sale`,
        workflowId: `${ORG_NONE}_wf`,
        paymentHash: `${PREFIX}hash`,
        executionId: null,
        kind: "calldata",
        amountUsdc: "1",
        payerAddress: "0x3",
        creatorWalletAddress: "0x4",
      });
    });

    async function runExists(id: string): Promise<boolean> {
      const rows =
        await queryClient`SELECT 1 FROM workflow_executions WHERE id = ${id}`;
      return rows.length > 0;
    }

    it("touches no run row while its own switch is off", async () => {
      const result = await runRetentionPurge(config(), NOW);
      expect(
        result.passes.find((p) => p.pass === "executions_flat_window")?.skipped
      ).toBe("disabled");
      expect(await runExists(`${PREFIX}unpaid_500`)).toBe(true);
    });

    it("retires an unpaid run past the window and keeps a paid one", async () => {
      await runRetentionPurge(config({ executionsEnabled: true }), NOW);
      expect(await runExists(`${PREFIX}unpaid_500`)).toBe(false);
      expect(await runExists(`${PREFIX}paid_500`)).toBe(true);
      // A calldata-only sale carries no execution; its NULL must not stop the
      // pass from deleting anything.
      expect(await runExists(runId(ORG_ENT, "inside"))).toBe(true);
    });

    it("leaves no orphaned child rows behind", async () => {
      await runRetentionPurge(config({ executionsEnabled: true }), NOW);
      const rows = await queryClient`
        SELECT count(*)::int AS n FROM workflow_execution_logs l
         WHERE NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.id = l.execution_id)`;
      expect(rows[0].n).toBe(0);
    });

    it("still knows every table that references a run row", async () => {
      // The pass deletes workflow_execution_logs and feedback before the parent
      // because neither cascades. A further non-cascading child added later
      // would fail on a 500-day-old row in production; it fails here instead.
      // workflow_step_claims is listed but needs no pass: it cascades, which
      // the second assertion below is what actually holds it to.
      const rows = await queryClient`
        SELECT conrelid::regclass::text AS child, confdeltype AS on_delete
          FROM pg_constraint
         WHERE contype = 'f' AND confrelid = 'workflow_executions'::regclass
         ORDER BY 1`;
      expect(rows.map((r) => r.child)).toEqual([
        "feedback",
        "workflow_execution_logs",
        "workflow_step_claims",
      ]);
      // 'c' is cascade, 'a' is no action. A child the purge does not delete
      // itself has to cascade, or an aged parent delete fails.
      expect(
        rows.find((r) => r.child === "workflow_step_claims")?.on_delete
      ).toBe("c");
    });
  });
});
