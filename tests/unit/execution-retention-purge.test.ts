/**
 * KEEP-1042: control flow of the retention purge. The drizzle builder and every
 * operator are stubbed, so this asserts what the job DOES -- which passes run,
 * in what order, when it stops, what a dry run is allowed to touch, and that
 * the watermark only advances on a real drain -- not the SQL it emits. The SQL
 * is exercised against a real database before the job is enabled for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Operators become inert markers: the builder stub ignores them, and mocking
// them keeps a sub-select stub from being fed into real drizzle internals.
vi.mock("drizzle-orm", () => {
  const marker =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    and: marker("and"),
    eq: marker("eq"),
    gte: marker("gte"),
    inArray: marker("inArray"),
    isNotNull: marker("isNotNull"),
    lt: marker("lt"),
    count: marker("count"),
    min: marker("min"),
    notInArray: marker("notInArray"),
    sql: marker("sql"),
  };
});

vi.mock("@/lib/db/schema", () => ({
  executionRetentionProgress: { id: "progress" },
  organization: { id: "organization.id" },
  workflowExecutionLogs: { id: "logs.id" },
  workflowExecutions: { id: "executions.id" },
  workflows: { id: "workflows.id" },
}));
vi.mock("@/lib/db/schema-extensions", () => ({
  organizationSubscriptions: {},
  paygPayments: {},
}));
vi.mock("@/lib/db/schema-feedback", () => ({ feedback: {} }));
vi.mock("@/lib/db/schema-payments", () => ({ workflowPayments: {} }));
vi.mock("@/lib/billing/plans", () => ({
  // Two distinct windows, so the schedule has both a floor pass and a
  // per-organization group. With one window everything sits at the floor.
  getPlanLimits: (plan: string) => ({
    logRetentionDays: plan === "enterprise" ? 365 : 7,
  }),
  parsePlanName: (value: unknown) => value ?? "free",
  parseTierKey: () => null,
}));

// Hoisted with the vi.mock factories: the module under test imports `db` at
// load time, which happens before any top-level statement in this file runs.
const { state, dbStub } = vi.hoisted(() => {
  const hoistedState = {
    /** Rows returned by successive awaited id selects, in call order. */
    selectPages: [] as unknown[][],
    selectCalls: 0,
    /** Counts returned to a dry run's countEligible, in call order. */
    counts: [] as number[],
    countCalls: 0,
    /** Oldest still-resumable run per drained organization, in call order. */
    oldest: [] as Array<Date | null>,
    oldestCalls: 0,
    /** Instants handed to setPurgeWatermark, in call order. */
    watermarks: [] as unknown[],
    writes: [] as Array<{ op: string; table: unknown }>,
    /** Predicates handed to every select, in call order. */
    wheres: [] as unknown[],
    transactions: 0,
  };

  // The aggregate selects -- countEligible and earliestResumableStartedAt --
  // are answered from their own shape rather than from the page queue, so
  // adding one does not shift every page index in every test.
  function makeSelectBuilder(projection?: Record<string, unknown>) {
    const shape = projection ? Object.keys(projection) : [];
    let aggregate: (() => unknown[]) | null = null;
    if (shape.includes("n")) {
      aggregate = () => {
        const n = hoistedState.counts[hoistedState.countCalls] ?? 0;
        hoistedState.countCalls += 1;
        return [{ n }];
      };
    } else if (shape.includes("oldest")) {
      aggregate = () => {
        const oldest = hoistedState.oldest[hoistedState.oldestCalls] ?? null;
        hoistedState.oldestCalls += 1;
        return [{ oldest }];
      };
    }
    const builder: Record<string, unknown> = {};
    for (const method of [
      "from",
      "innerJoin",
      "leftJoin",
      "orderBy",
      "limit",
    ]) {
      builder[method] = () => builder;
    }
    builder.where = (predicate: unknown) => {
      hoistedState.wheres.push(predicate);
      return builder;
    };
    // A drizzle query builder is itself a thenable, which is exactly what this
    // stub has to imitate for `await db.select()...` to resolve.
    // biome-ignore lint/suspicious/noThenProperty: the builder under test is awaited directly
    builder.then = (
      resolve: (rows: unknown[]) => unknown,
      reject?: (error: unknown) => unknown
    ) => {
      try {
        if (aggregate) {
          return Promise.resolve(resolve(aggregate()));
        }
        const page = hoistedState.selectPages[hoistedState.selectCalls] ?? [];
        hoistedState.selectCalls += 1;
        return Promise.resolve(resolve(page));
      } catch (error) {
        return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
      }
    };
    return builder;
  }

  function makeWriteBuilder(op: string, table: unknown) {
    const builder: Record<string, unknown> = {};
    builder.set = () => builder;
    builder.values = (row: Record<string, unknown>) => {
      hoistedState.watermarks.push(row?.executionsPurgedThrough);
      return builder;
    };
    builder.onConflictDoUpdate = () => {
      hoistedState.writes.push({ op, table });
      return Promise.resolve();
    };
    builder.where = () => {
      hoistedState.writes.push({ op, table });
      return Promise.resolve();
    };
    return builder;
  }

  const hoistedDb: Record<string, unknown> = {
    select: (projection?: Record<string, unknown>) =>
      makeSelectBuilder(projection),
    delete: (table: unknown) => makeWriteBuilder("delete", table),
    update: (table: unknown) => makeWriteBuilder("update", table),
    insert: (table: unknown) => makeWriteBuilder("insert", table),
    execute: (statement: unknown) => {
      hoistedState.writes.push({ op: "execute", table: statement });
      return Promise.resolve([]);
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      hoistedState.transactions += 1;
      return callback(hoistedDb);
    },
  };

  return { state: hoistedState, dbStub: hoistedDb };
});

vi.mock("@/lib/db", () => ({ db: dbStub }));

import { getRetentionConfig } from "@/lib/retention/config";
import { runRetentionPurge } from "@/lib/retention/purge-executions";

const NOW = new Date("2026-09-07T12:00:00.000Z");

/** Two organizations on two windows, as resolveOrgRetentionWindows sees them. */
const ORG_ROWS = [
  { organizationId: "org-free", plan: "free", tier: null, planOverrides: null },
  {
    organizationId: "org-ent",
    plan: "enterprise",
    tier: null,
    planOverrides: null,
  },
];

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return { ...getRetentionConfig(), enabled: true, ...overrides };
}

beforeEach(() => {
  state.selectPages = [];
  state.selectCalls = 0;
  state.counts = [];
  state.countCalls = 0;
  state.oldest = [];
  state.oldestCalls = 0;
  state.watermarks = [];
  state.writes = [];
  state.wheres = [];
  state.transactions = 0;
});

/** Depth-first search for an operator marker of `kind` in a predicate tree. */
function findMarkers(node: unknown, kind: string): Array<{ args: unknown[] }> {
  if (Array.isArray(node)) {
    return node.flatMap((child) => findMarkers(child, kind));
  }
  if (node && typeof node === "object") {
    const marker = node as { kind?: string; args?: unknown[] };
    const here = marker.kind === kind ? [{ args: marker.args ?? [] }] : [];
    return here.concat(findMarkers(marker.args, kind));
  }
  return [];
}

describe("runRetentionPurge", () => {
  it("touches nothing at all while the switch is off", async () => {
    const result = await runRetentionPurge(getRetentionConfig(), NOW);

    expect(result).toMatchObject({
      enabled: false,
      dryRun: false,
      durationMs: 0,
      passes: [],
      totalRows: 0,
    });
    expect(state.selectCalls).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("runs every pass, child rows before parent rows", async () => {
    state.selectPages = [ORG_ROWS];

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.passes.map((pass) => pass.pass)).toEqual([
      "logs_floor",
      "logs_plan_window",
      "output_raw",
      "logs_soft_deleted",
      "executions_flat_window",
    ]);
  });

  it("runs the floor pass at the longest window in use, not at the ceiling", async () => {
    state.selectPages = [ORG_ROWS];

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.floorDays).toBe(365);
  });

  it("leaves run rows alone until their own switch is turned on", async () => {
    state.selectPages = [ORG_ROWS];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const executionPass = result.passes.find(
      (pass) => pass.pass === "executions_flat_window"
    );

    // Deleting a run row rewrites what a customer was billed, so this pass
    // ships off and stays off until a durable usage record exists.
    expect(executionPass).toEqual({
      pass: "executions_flat_window",
      rows: 0,
      budgetExhausted: false,
      skipped: "disabled",
    });
    expect(state.transactions).toBe(0);
  });

  it("deletes a page, then stops when the next page is empty", async () => {
    state.selectPages = [ORG_ROWS, [{ id: "log-1" }, { id: "log-2" }]];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const floorPass = result.passes.find((pass) => pass.pass === "logs_floor");

    expect(floorPass).toEqual({
      pass: "logs_floor",
      rows: 2,
      budgetExhausted: false,
    });
    expect(state.writes[0]).toEqual({ op: "delete", table: { id: "logs.id" } });
  });

  it("reports the organization count and rows for each window", async () => {
    // orgs, floor pass, watermarks, then the free group's first page.
    state.selectPages = [ORG_ROWS, [], [], [{ id: "log-1" }]];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    // A dry run of this is the pre-flight check that every organization
    // resolved to the window it pays for.
    expect(planPass?.windows).toEqual([
      { retentionDays: 7, organizationCount: 1, rows: 1 },
    ]);
  });

  it("advances the watermark once an organization has drained", async () => {
    state.selectPages = [ORG_ROWS, [], [], [{ id: "log-1" }]];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(state.writes).toContainEqual({
      op: "insert",
      table: { id: "progress" },
    });
  });

  it("stops the watermark at the oldest run it had to skip", async () => {
    // The drain query excludes runs that can still resume, so an empty page
    // does not mean the range is empty. Advancing to the cutoff would move the
    // lower bound past those rows and, because the bound is inclusive below,
    // they would never be selected again -- a run that is phantom today and
    // succeeds tomorrow would keep its step logs until the floor pass.
    const skipped = new Date("2026-08-18T12:00:00.000Z");
    state.selectPages = [ORG_ROWS, [], [], []];
    state.oldest = [skipped];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(state.watermarks).toEqual([skipped]);
  });

  it("advances to the cutoff when it skipped nothing", async () => {
    state.selectPages = [ORG_ROWS, [], [], []];
    state.oldest = [null];

    await runRetentionPurge(enabledConfig(), NOW);

    // org-free is on the 7-day window; org-ent sits at the floor and never
    // enters the per-organization pass.
    expect(state.watermarks).toEqual([new Date("2026-08-31T12:00:00.000Z")]);
  });

  it("counts every eligible row and writes nothing in a dry run", async () => {
    // Deliberately more rows than one batch: the reported figure used to be
    // the first page, so it was silently capped at batchSize per pass and per
    // organization. An operator reads this number before turning dry-run off.
    state.selectPages = [ORG_ROWS];
    state.counts = [4200];

    const result = await runRetentionPurge(
      enabledConfig({ dryRun: true, batchSize: 2 }),
      NOW
    );

    expect(result.dryRun).toBe(true);
    expect(result.passes[0]).toEqual({
      pass: "logs_floor",
      rows: 4200,
      budgetExhausted: false,
    });
    // Including the watermark: a dry run deleted nothing, so it must not claim
    // an organization has drained.
    expect(state.writes).toEqual([]);
    expect(state.transactions).toBe(0);
  });

  it("stops on the runtime budget instead of overlapping the next run", async () => {
    // Endless work: every select returns a full page, so only the budget can
    // end the pass.
    state.selectPages = new Proxy([] as unknown[][], {
      get: (_target, prop) =>
        prop === "length" ? Number.MAX_SAFE_INTEGER : [{ id: "log-1" }],
    });

    const result = await runRetentionPurge(
      enabledConfig({ maxRuntimeMs: 0 }),
      NOW
    );

    expect(result.passes.some((pass) => pass.budgetExhausted)).toBe(true);
    expect(state.writes).toEqual([]);
  });

  it("nulls output_raw with an UPDATE rather than deleting the row", async () => {
    // orgs, floor, watermarks, free group, then the output_raw page.
    state.selectPages = [ORG_ROWS, [], [], [], [{ id: "log-9" }]];

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.passes.find((pass) => pass.pass === "output_raw")?.rows).toBe(
      1
    );
    expect(state.writes).toContainEqual({
      op: "update",
      table: { id: "logs.id" },
    });
  });

  it("retires a run row and its children in one transaction", async () => {
    // Nothing until the last pass: orgs, floor, watermarks, free group,
    // output_raw, soft-deleted, then one execution.
    state.selectPages = [ORG_ROWS, [], [], [], [], [], [{ id: "exec-1" }]];

    const result = await runRetentionPurge(
      enabledConfig({ executionsEnabled: true }),
      NOW
    );
    const executionPass = result.passes.find(
      (pass) => pass.pass === "executions_flat_window"
    );

    expect(executionPass?.rows).toBe(1);
    expect(state.transactions).toBe(1);
    // Children first: nothing cascades, so a parent delete with a surviving
    // child simply fails. The watermark write from the plan-window pass is not
    // part of that ordering.
    expect(
      state.writes
        .filter((write) => write.op !== "insert" && write.op !== "execute")
        .map((write) => write.table)
    ).toEqual([{ id: "logs.id" }, {}, { id: "executions.id" }]);
  });

  it("skips a run that can still resume in both short-window passes", async () => {
    // The plan window can be as short as 7 days, and a resumable run's step
    // logs carry the output_raw the executor reads to pick it back up. The
    // floor and run-row passes deliberately carry no such guard.
    state.selectPages = [ORG_ROWS];

    await runRetentionPurge(enabledConfig(), NOW);

    const statusGuards = state.wheres
      .flatMap((where) => findMarkers(where, "notInArray"))
      .filter(
        (guard) =>
          Array.isArray(guard.args[1]) &&
          (guard.args[1] as string[]).includes("running")
      );

    expect(statusGuards.length).toBeGreaterThanOrEqual(2);
    expect(statusGuards[0].args[1]).toEqual([
      "pending",
      "running",
      "phantom",
      "unconfirmed",
    ]);
  });
});
