/**
 * Step and run output is user data, but some queries read numbers from it.
 * This seeds non-numeric values next to valid ones and checks that every
 * reader returns, with the valid values intact.
 */

import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StepLog, UnifiedRun } from "../../lib/analytics/types";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";
import type { RefusedRun } from "../../lib/notifications/failure-alerts/streak-runs";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these queries must run on Postgres.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_nonnum_out_";
const ORG_ID = `${PREFIX}org`;
const USER_ID = `${PREFIX}user`;
const RUNS_WF = `${PREFIX}wf_runs`;
const ATTEMPTS_WF = `${PREFIX}wf_attempts`;
const REFUSED_WF = `${PREFIX}wf_refused`;
const BIG_REFUSALS_WF = `${PREFIX}wf_big_refusals`;

/** Past the 78-digit cap (uint256), and past what numeric can hold. */
const DIGITS_78 = "1".repeat(78);
const DIGITS_79 = "1".repeat(79);
const DIGITS_131073 = "1".repeat(131_073);

/** What a step's or a run's own output may hold where KeeperHub writes a number. */
const BAD_VALUES: unknown[] = [
  "",
  "x",
  1.5,
  -2,
  { a: 1 },
  "1.5",
  // The old raw CAST accepted these four.
  "0x5208",
  " 21000 ",
  "1e3",
  "1_000",
  DIGITS_79,
  DIGITS_131073,
];
/** Fits numeric gas and a bigint refusal count. */
const TWELVE_DIGITS = 123_456_789_012;

const VALID_RUN = `${PREFIX}exec_valid`;
const BIG_RUN = `${PREFIX}exec_big`;
const MIXED_RUN = `${PREFIX}exec_mixed`;
const ENCODED_RUN = `${PREFIX}exec_encoded`;
const ENCODED_VALID_RUN = `${PREFIX}exec_encoded_valid`;
const TRIGGER_RUN = `${PREFIX}exec_trigger`;
const STEP_RUN = `${PREFIX}exec_step_write`;
const BACKFILL_RUN = `${PREFIX}exec_backfill`;
const ORACLE_RUN = `${PREFIX}exec_oracle`;
const badRunId = (i: number): string => `${PREFIX}exec_bad_${i}`;

const STEP_HUGE_LOG = `${PREFIX}log_step_write_huge`;
const STEP_VALID_LOG = `${PREFIX}log_step_write_valid`;
// Log ids are the backfill's keyset cursor: these two sort after every other fixture row.
const BACKFILL_CURSOR = `${PREFIX}log_zz_`;
const BACKFILL_VALID_LOG = `${BACKFILL_CURSOR}a_valid`;
const BACKFILL_BAD_LOG = `${BACKFILL_CURSOR}b_bad`;

/** One table through both the JS column writer and the SQL read. */
const ORACLE_VALUES: unknown[] = [
  "",
  "x",
  1.5,
  "1.5",
  -2,
  "1e3",
  "0x5208",
  " 21000 ",
  "21000\n",
  "007",
  true,
  {},
  21_000,
  "123456789012",
  DIGITS_78,
  DIGITS_79,
  1e21,
];

describe.skipIf(SKIP)("non-numeric step output in run queries", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getUnifiedRuns: (
    organizationId: string,
    range: "7d",
    options?: { limit?: number }
  ) => Promise<{ runs: UnifiedRun[] }>;
  let getStepLogs: (
    executionId: string,
    organizationId: string
  ) => Promise<StepLog[]>;
  let loadRefusalStreak: (
    workflowId: string,
    events: number,
    since: Date | null
  ) => Promise<RefusedRun[] | null>;
  let loadNewestRefusal: (
    workflowId: string,
    since: Date
  ) => Promise<RefusedRun | null>;

  const now = new Date();
  const minutesAgo = (m: number): Date => new Date(now.getTime() - m * 60_000);

  async function cleanup(): Promise<void> {
    const pattern = `${PREFIX}%`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${pattern}`;
    await queryClient`DELETE FROM alert_queue WHERE workflow_id LIKE ${pattern}`;
    await queryClient`DELETE FROM workflow_executions WHERE workflow_id LIKE ${pattern}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${pattern}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${pattern}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${pattern}`;
  }

  function workflow(id: string) {
    return {
      id,
      name: id,
      userId: USER_ID,
      organizationId: ORG_ID,
      enabled: true,
      nodes: [],
      edges: [],
    };
  }

  function gasStep(
    executionId: string,
    suffix: string,
    output: unknown
  ): typeof workflowExecutionLogs.$inferInsert {
    return {
      id: `${PREFIX}log_${executionId.slice(PREFIX.length)}_${suffix}`,
      executionId,
      nodeId: `step-${suffix}`,
      nodeName: "Step",
      nodeType: "code",
      status: "success",
      input: {},
      output,
      startedAt: now,
      // Unset like a pre-0117 row (or one the writer nulled), so the JSONB is read.
      gasUsedWei: null,
    };
  }

  async function logColumns(
    id: string
  ): Promise<{ status: string; gas: string | null; network: string | null }> {
    const [row] = await db
      .select({
        status: workflowExecutionLogs.status,
        gas: sql<string | null>`${workflowExecutionLogs.gasUsedWei}::text`,
        network: workflowExecutionLogs.network,
      })
      .from(workflowExecutionLogs)
      .where(eq(workflowExecutionLogs.id, id));
    if (!row) {
      throw new Error(`seeded log ${id} missing`);
    }
    return row;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    await db.insert(organization).values({
      id: ORG_ID,
      name: "non-numeric output org",
      slug: ORG_ID,
      createdAt: now,
    });
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(workflows)
      .values([
        workflow(RUNS_WF),
        workflow(ATTEMPTS_WF),
        workflow(REFUSED_WF),
        workflow(BIG_REFUSALS_WF),
      ]);

    // Analytics: one run per bad value, next to runs with valid gas.
    const run = (
      id: string,
      status: "success" | "running" = "success"
    ): typeof workflowExecutions.$inferInsert => ({
      id,
      workflowId: RUNS_WF,
      userId: USER_ID,
      status,
      startedAt: now,
      completedAt: status === "success" ? now : null,
      totalSteps: "1",
      completedSteps: "1",
    });
    await db.insert(workflowExecutions).values([
      run(VALID_RUN),
      run(BIG_RUN),
      // Finalized by a test below, which resolves its run-total gas.
      run(MIXED_RUN, "running"),
      run(ENCODED_RUN),
      run(ENCODED_VALID_RUN),
      run(TRIGGER_RUN),
      run(STEP_RUN, "running"),
      run(BACKFILL_RUN),
      run(ORACLE_RUN),
      ...BAD_VALUES.map((_, i) => run(badRunId(i))),
    ]);
    await db.insert(workflowExecutionLogs).values([
      gasStep(VALID_RUN, "a", { gasUsed: "21000" }),
      gasStep(BIG_RUN, "a", { gasUsed: TWELVE_DIGITS }),
      gasStep(MIXED_RUN, "a", { gasUsed: "31000" }),
      gasStep(MIXED_RUN, "b", { gasUsed: "x", triggerGasUsed: "" }),
      gasStep(MIXED_RUN, "c", { gasUsed: DIGITS_131073 }),
      // A bad gasUsed falls through to the trigger's own fee.
      gasStep(TRIGGER_RUN, "a", { gasUsed: "x", triggerGasUsed: "77000" }),
      ...BAD_VALUES.map((value, i) =>
        gasStep(badRunId(i), "a", { gasUsed: value, triggerGasUsed: value })
      ),
      ...ORACLE_VALUES.map((value, i) =>
        gasStep(ORACLE_RUN, String(i).padStart(2, "0"), { gasUsed: value })
      ),
      {
        id: STEP_HUGE_LOG,
        executionId: STEP_RUN,
        nodeId: "step-huge",
        nodeName: "Step",
        nodeType: "code",
        status: "running",
        input: {},
        startedAt: now,
      },
      {
        id: STEP_VALID_LOG,
        executionId: STEP_RUN,
        nodeId: "step-valid",
        nodeName: "Step",
        nodeType: "code",
        status: "running",
        input: {},
        startedAt: now,
      },
      // Both need a backfill (network unset); only the valid one has gas.
      {
        ...gasStep(BACKFILL_RUN, "a", { gasUsed: "41000" }),
        id: BACKFILL_VALID_LOG,
        input: { network: "base" },
      },
      {
        ...gasStep(BACKFILL_RUN, "b", { gasUsed: "x" }),
        id: BACKFILL_BAD_LOG,
        input: { network: "base" },
      },
    ]);
    // The double-encoded shape (a JSON string holding the object).
    for (const [executionId, gasUsed] of [
      [ENCODED_RUN, ""],
      [ENCODED_VALID_RUN, "21000"],
    ]) {
      await queryClient`INSERT INTO workflow_execution_logs
        (id, execution_id, node_id, node_name, node_type, status, input, output, started_at)
        VALUES (${`${executionId}_log`}, ${executionId}, 'step-a', 'Step', 'code', 'success',
          '{}'::jsonb, to_jsonb(${JSON.stringify({ gasUsed })}::text), ${now.toISOString()})`;
    }

    // Failure alerts: a refused row (valid count) above finished runs whose own output holds a bad one.
    type Kind = "success" | "failed" | "skipped" | "billing";
    const attempt = (
      id: string,
      workflowId: string,
      at: Date,
      output: unknown,
      kind: Kind
    ): typeof workflowExecutions.$inferInsert => ({
      id,
      workflowId,
      userId: USER_ID,
      organizationId: ORG_ID,
      status: kind === "success" || kind === "skipped" ? kind : "error",
      triggerSource: "webhook",
      output,
      startedAt: at,
      completedAt: at,
      ...(kind === "failed"
        ? {
            error: "Step failed",
            errorCategory: "validation",
            errorType: "user",
          }
        : {}),
      // A refusal: skipped, or a billing error that was never billable.
      ...(kind === "skipped" || kind === "billing"
        ? {
            error: "Execution limit reached",
            errorCategory: "billing",
            errorType: "user",
            billable: false,
          }
        : {}),
    });
    // A count is a JSON number of at most 18 digits: 1e20 overflows a bigint, "7" is a string.
    const attemptValues = [...BAD_VALUES, 1e20, "7"];
    await db.insert(workflowExecutions).values([
      attempt(
        `${PREFIX}att_refused`,
        ATTEMPTS_WF,
        minutesAgo(1),
        { refusals: attemptValues.length + 1 },
        "skipped"
      ),
      ...attemptValues.map((value, i) =>
        attempt(
          `${PREFIX}att_${i}`,
          ATTEMPTS_WF,
          minutesAgo(10 + i),
          { refusals: value },
          i % 2 === 0 ? "success" : "failed"
        )
      ),
      // Refused rows holding a bad count: each stands for one refusal.
      attempt(
        `${PREFIX}ref_valid`,
        REFUSED_WF,
        minutesAgo(1),
        { refusals: 2 },
        "skipped"
      ),
      ...attemptValues.map((value, i) =>
        attempt(
          `${PREFIX}ref_${i}`,
          REFUSED_WF,
          minutesAgo(10 + i),
          { refusals: value },
          i % 2 === 0 ? "skipped" : "billing"
        )
      ),
      attempt(
        `${PREFIX}big_ref`,
        BIG_REFUSALS_WF,
        minutesAgo(1),
        { refusals: TWELVE_DIGITS },
        "skipped"
      ),
    ]);

    ({ getUnifiedRuns, getStepLogs } = await import("@/lib/analytics/queries"));
    ({ loadRefusalStreak, loadNewestRefusal } = await import(
      "@/lib/notifications/failure-alerts/streak-runs"
    ));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("lists the org's runs, valid gas intact and a bad gasUsed read as no gas", async () => {
    const { runs } = await getUnifiedRuns(ORG_ID, "7d", { limit: 100 });
    const gasOf = (id: string): string | null | undefined =>
      runs.find((r) => r.id === id)?.gasUsedWei;

    expect(gasOf(VALID_RUN)).toBe("21000");
    expect(gasOf(BIG_RUN)).toBe(String(TWELVE_DIGITS));
    expect(gasOf(MIXED_RUN)).toBe("31000");
    expect(gasOf(ENCODED_RUN)).toBeNull();
    expect(gasOf(ENCODED_VALID_RUN)).toBe("21000");
    for (const [i] of BAD_VALUES.entries()) {
      expect(runs.some((r) => r.id === badRunId(i))).toBe(true);
      expect(gasOf(badRunId(i))).toBeNull();
    }
  });

  it("lists a run's steps, a bad gasUsed or triggerGasUsed read as no gas", async () => {
    const mixed = await getStepLogs(MIXED_RUN, ORG_ID);
    expect(mixed.map((s) => s.gasCostWei ?? "none").sort()).toEqual([
      "31000",
      "none",
      "none",
    ]);
    const trigger = await getStepLogs(TRIGGER_RUN, ORG_ID);
    expect(trigger.map((s) => s.gasCostWei)).toEqual(["77000"]);
    for (const [i] of BAD_VALUES.entries()) {
      const steps = await getStepLogs(badRunId(i), ORG_ID);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.gasCostWei).toBeNull();
    }
  });

  it("writes the run-total gas at finalize from the valid steps only", async () => {
    const { logWorkflowCompleteDb } = await import(
      "@/lib/workflow/executor/logging"
    );
    await logWorkflowCompleteDb({
      executionId: MIXED_RUN,
      status: "success",
      startTime: now.getTime(),
    });
    const [row] = await db
      .select({
        status: workflowExecutions.status,
        gas: sql<string | null>`${workflowExecutions.gasUsedWei}::text`,
      })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, MIXED_RUN));
    expect(row).toEqual({ status: "success", gas: "31000" });
  });

  it("completes a step whose gasUsed is too long for numeric, leaving its gas column empty", async () => {
    const { logStepCompleteDb } = await import(
      "@/lib/workflow/executor/logging"
    );
    for (const [logId, gasUsed] of [
      [STEP_HUGE_LOG, DIGITS_131073],
      [STEP_VALID_LOG, "21000"],
    ]) {
      await logStepCompleteDb({
        logId,
        startTime: now.getTime(),
        status: "success",
        output: { gasUsed },
        outputRaw: { gasUsed },
        executionId: STEP_RUN,
      });
    }
    expect(await logColumns(STEP_HUGE_LOG)).toMatchObject({
      status: "success",
      gas: null,
    });
    expect(await logColumns(STEP_VALID_LOG)).toMatchObject({
      status: "success",
      gas: "21000",
    });
  });

  it("backfills a batch holding a bad gasUsed: the bad row's gas stays empty, the valid one fills", async () => {
    const { applyBatch } = await import(
      "@/scripts/lib/exec-log-network-gas-backfill"
    );
    expect(await applyBatch(BACKFILL_CURSOR, 2)).toBe(2);
    expect(await logColumns(BACKFILL_VALID_LOG)).toMatchObject({
      gas: "41000",
      network: "base",
    });
    expect(await logColumns(BACKFILL_BAD_LOG)).toMatchObject({
      gas: null,
      network: "base",
    });
  });

  it("reads gas the same way in the JS column writer and the SQL fallback", async () => {
    const { extractLogGasUsedWei, logOutputWei } = await import(
      "@/lib/db/execution-log-fields"
    );
    const rows = await db
      .select({
        id: workflowExecutionLogs.id,
        wei: sql<string | null>`(${logOutputWei("gasUsed")})::text`,
      })
      .from(workflowExecutionLogs)
      .where(eq(workflowExecutionLogs.executionId, ORACLE_RUN))
      .orderBy(workflowExecutionLogs.id);
    expect(rows).toHaveLength(ORACLE_VALUES.length);

    const outcomes = ORACLE_VALUES.map((value, i) => {
      const js = extractLogGasUsedWei({ gasUsed: value });
      // Written to the numeric column, "007" reads back as 7.
      return {
        value,
        js: js === null ? null : BigInt(js).toString(),
        sql: rows[i]?.wei ?? null,
      };
    });
    // 1e21 diverges: JS reads "1e+21" (null), jsonb reads its digits; reads COALESCE to the SQL value.
    const diverging = outcomes.filter((o) => o.js !== o.sql);
    expect(diverging).toEqual([
      { value: 1e21, js: null, sql: "1000000000000000000000" },
    ]);
    expect(
      Object.fromEntries(
        outcomes
          .filter((o) => o.js !== null)
          .map((o) => [String(o.value), o.js])
      )
    ).toEqual({
      "007": "7",
      "21000": "21000",
      "123456789012": "123456789012",
      [DIGITS_78]: DIGITS_78,
    });
  });

  it("reads a refusal streak past runs whose output holds a non-numeric refusals", async () => {
    const events = BAD_VALUES.length + 3;
    const streak = await loadRefusalStreak(ATTEMPTS_WF, events, null);
    expect(streak?.map((r) => r.refusals)).toEqual([events]);
  });

  it("counts a refused row holding a bad refusals as one refusal", async () => {
    const events = 2 + BAD_VALUES.length + 2;
    const streak = await loadRefusalStreak(REFUSED_WF, events, null);
    expect(streak?.map((r) => r.refusals)).toEqual([
      2,
      ...Array.from({ length: BAD_VALUES.length + 2 }, () => 1),
    ]);
    const newest = await loadNewestRefusal(REFUSED_WF, minutesAgo(60));
    expect(newest?.refusals).toBe(2);
  });

  it("keeps a refusal count past the int range exact", async () => {
    const newest = await loadNewestRefusal(BIG_REFUSALS_WF, minutesAgo(60));
    expect(newest?.refusals).toBe(TWELVE_DIGITS);
  });
});
