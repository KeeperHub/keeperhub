/**
 * KEEP-1042: control flow of the retention purge. The drizzle builder and every
 * operator are stubbed, so this asserts what the job DOES -- which passes run,
 * in what order, when it stops, what a dry run is allowed to touch, and that
 * the watermark only advances on a real drain -- not the SQL it emits. The SQL
 * is exercised against a real database before the job is enabled for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The purge logs an organization it has to skip. The real module pulls in
// Sentry and the metrics collector, neither of which this suite is about.
vi.mock("@/lib/logging", () => ({ logWarn: vi.fn() }));

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
    // sql doubles as a namespace: the watermark backfill binds its timestamp
    // through sql.param, because postgres.js has no encoder for a bare Date.
    sql: Object.assign(marker("sql"), { param: marker("param") }),
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
  // planOverrides is honoured so a test can build a THIRD window and therefore
  // a second per-organization group; every other fixture row passes null.
  getPlanLimits: (
    plan: string,
    _tier: unknown,
    overrides?: { logRetentionDays?: number } | null
  ) => ({
    logRetentionDays:
      overrides?.logRetentionDays ?? (plan === "enterprise" ? 365 : 7),
  }),
  parsePlanName: (value: unknown) => value ?? "free",
  parseTierKey: () => null,
}));

// Hoisted with the vi.mock factories: the module under test imports `db` at
// load time, which happens before any top-level statement in this file runs.
const { state, dbStub } = vi.hoisted(() => {
  const hoistedState = {
    /**
     * Rows returned by successive awaited id selects, in call order. An Error
     * in the queue stands for a statement the database refused; a function is
     * called when its read happens, for a test that must act at that moment.
     */
    selectPages: [] as Array<unknown[] | Error | (() => unknown[])>,
    selectCalls: 0,
    /** Counts returned to a dry run's count selects, in call order. */
    counts: [] as number[],
    countCalls: 0,
    /** Oldest still-resumable run per drained slice, in call order. */
    oldest: [] as Array<Date | null | Error>,
    oldestCalls: 0,
    /** Instants handed to setPurgeWatermark, in call order. */
    watermarks: [] as unknown[],
    /** Organizations whose subscription changed inside the grace. */
    changed: [] as string[],
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
        // An Error stands for a statement the database refused, as it does in
        // the page queue: this read runs under the same bound as the runs read.
        if (oldest instanceof Error) {
          throw oldest;
        }
        return [{ oldest }];
      };
    } else if (shape.includes("changedOrganizationId")) {
      aggregate = () =>
        hoistedState.changed.map((id) => ({ changedOrganizationId: id }));
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
        const entry = hoistedState.selectPages[hoistedState.selectCalls] ?? [];
        hoistedState.selectCalls += 1;
        if (entry instanceof Error) {
          throw entry;
        }
        const page = typeof entry === "function" ? entry() : entry;
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
import {
  PLAN_WINDOW_CEILING_RECOVERY_SLICES,
  PLAN_WINDOW_MIN_CEILING_MS,
  PLAN_WINDOW_MIN_SLICE_MS,
  PLAN_WINDOW_RUNS_PER_READ,
  PLAN_WINDOW_WORKFLOW_CHUNK,
  RetentionPurgeIncompleteError,
  runRetentionPurge,
} from "@/lib/retention/purge-executions";

const NOW = new Date("2026-09-07T12:00:00.000Z");

/** The 7-day group's cutoff at NOW. */
const FREE_CUTOFF = new Date("2026-08-31T12:00:00.000Z");

/** The slice width enabledConfig carries, which is the production default. */
const SLICE_MS = 24 * 60 * 60 * 1000;

/** More eligible runs than one read of a workflow chunk may return. */
const OVERFLOW = Array.from(
  { length: PLAN_WINDOW_RUNS_PER_READ + 1 },
  (_, index) => ({ id: `exec-${index}` })
);

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

/**
 * A watermark row leaving `slices` whole initial slices below the free group's
 * cutoff, as getPurgeWatermarks returns them.
 *
 * Without one the walk starts at the epoch, and since KEEP-1360 capped the
 * first slice that is fifteen doubling slices of empty range -- true to
 * production, but it buries whatever the test is actually asserting. A seeded
 * watermark puts each test on a range it can state exactly.
 */
function watermarkRow(slices: number, organizationId = "org-free") {
  return {
    organizationId,
    executionsPurgedThrough: new Date(
      FREE_CUTOFF.getTime() - slices * SLICE_MS
    ),
  };
}

/** A read the statement_timeout cancelled, as postgres reports it. */
function cancelledRead(): Error {
  return Object.assign(
    new Error("canceling statement due to statement timeout"),
    { code: "57014" }
  );
}

beforeEach(() => {
  vi.useRealTimers();
  state.selectPages = [];
  state.selectCalls = 0;
  state.counts = [];
  state.countCalls = 0;
  state.oldest = [];
  state.oldestCalls = 0;
  state.watermarks = [];
  state.changed = [];
  state.writes = [];
  state.wheres = [];
  state.transactions = 0;
});

/** The workflow-id list of every chunk read, in call order. */
function workflowChunkReads(): string[][] {
  return state.wheres
    .flatMap((where) => findMarkers(where, "inArray"))
    .map((marker) => marker.args[1])
    .filter(
      (ids): ids is string[] =>
        Array.isArray(ids) && String(ids[0]).startsWith("wf-")
    );
}

/** The [from, to) bounds of every runs read of a workflow chunk, in call order. */
function sliceReads(): [Date, Date][] {
  return state.wheres
    .filter((where) =>
      findMarkers(where, "inArray").some((marker) => {
        const ids = marker.args[1];
        return Array.isArray(ids) && String(ids[0]).startsWith("wf-");
      })
    )
    .map((where) => [
      findMarkers(where, "gte")[0].args[1] as Date,
      findMarkers(where, "lt")[0].args[1] as Date,
    ]);
}

/** The [from, to) bounds of every skipped-run read, in call order. */
function resumableReads(): [Date, Date][] {
  return state.wheres
    .filter((where) =>
      findMarkers(where, "inArray").some((marker) => {
        const values = marker.args[1];
        return Array.isArray(values) && values[0] === "pending";
      })
    )
    .map((where) => [
      findMarkers(where, "gte")[0].args[1] as Date,
      findMarkers(where, "lt")[0].args[1] as Date,
    ]);
}

/** How wide each of those reads was, in ms. */
function sliceSpans(): number[] {
  return sliceReads().map(([from, to]) => to.getTime() - from.getTime());
}

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
      "logs_soft_deleted",
      "executions_flat_window",
      // Last: its backlog, and its dry-run walk, can spend the whole budget.
      "output_raw",
    ]);
  });

  it("runs the floor pass at the longest window in use, not at the ceiling", async () => {
    state.selectPages = [ORG_ROWS];

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.floorDays).toBe(365);
  });

  it("leaves run rows alone until their own switch is turned on", async () => {
    state.selectPages = [ORG_ROWS, [], [watermarkRow(1)]];

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
    // The one transaction is the plan-window pass reading its skipped run under
    // the tighter timeout; the run-row pass opens none while its switch is off.
    expect(state.transactions).toBe(1);
  });

  it("deletes page by page, then stops when the next page is empty", async () => {
    state.selectPages = [
      ORG_ROWS,
      [
        { id: "log-1", at: "2025-08-01 10:00:00.000001" },
        { id: "log-2", at: "2025-08-01 10:00:00.000002" },
      ],
      [{ id: "log-3", at: "2025-08-01 10:00:00.000003" }],
    ];

    const result = await runRetentionPurge(
      enabledConfig({ batchSize: 2 }),
      NOW
    );
    const floorPass = result.passes.find((pass) => pass.pass === "logs_floor");

    expect(floorPass).toEqual({
      pass: "logs_floor",
      rows: 3,
      budgetExhausted: false,
    });
    // One delete per page, and nothing for the empty page that ends the walk.
    expect(state.writes.filter((write) => write.op === "delete")).toEqual([
      { op: "delete", table: { id: "logs.id" } },
      { op: "delete", table: { id: "logs.id" } },
    ]);
  });

  it("starts each page right after the last row of the page before", async () => {
    // Without the cursor every page started again at the front of the index
    // and walked past everything earlier pages had already removed. The
    // timestamp travels as Postgres printed it, microseconds included.
    state.selectPages = [
      ORG_ROWS,
      [
        { id: "log-1", at: "2025-08-01 10:00:00.123456" },
        { id: "log-2", at: "2025-08-01 10:00:00.654321" },
      ],
    ];

    await runRetentionPurge(enabledConfig({ batchSize: 2 }), NOW);

    const cursors = state.wheres
      .flatMap((where) => findMarkers(where, "sql"))
      .filter((marker) =>
        marker.args.some((arg) => String(arg).startsWith("log-"))
      );
    expect(cursors).toHaveLength(1);
    expect(cursors[0].args.slice(-2)).toEqual([
      "2025-08-01 10:00:00.654321",
      "log-2",
    ]);
  });

  it("reports the organization count and rows for each window", async () => {
    // orgs, floor pass, watermarks, then the free organization's workflows,
    // their runs, and a page of those runs' step logs.
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [{ id: "wf-1" }],
      [{ id: "exec-1" }],
      [{ id: "log-1" }],
    ];

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
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [{ id: "wf-1" }],
      [{ id: "exec-1" }],
      [{ id: "log-1" }],
    ];

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
    const skipped = new Date(FREE_CUTOFF.getTime() - SLICE_MS / 2);
    state.selectPages = [ORG_ROWS, [], [watermarkRow(1)], []];
    state.oldest = [skipped];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(state.watermarks).toEqual([skipped]);
  });

  it("defers an organization whose plan changed inside the grace", async () => {
    // A lapsed plan: the row was just rewritten, so the shorter window must
    // not reach this organization until the grace has passed.
    state.selectPages = [ORG_ROWS];
    state.changed = ["org-free"];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    expect(planPass?.deferredOrganizations).toBe(1);
    expect(planPass?.rows).toBe(0);
    // Deferred, not drained: it must not claim a watermark.
    expect(state.watermarks).toEqual([]);
  });

  it("advances to the cutoff when it skipped nothing", async () => {
    state.selectPages = [ORG_ROWS, [], [watermarkRow(1)], []];
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
    // The floor and soft-delete passes answer it in one statement each.
    state.selectPages = [ORG_ROWS];
    state.counts = [4200, 12]; // floor, then soft-delete

    const result = await runRetentionPurge(
      enabledConfig({ dryRun: true, batchSize: 2 }),
      NOW
    );
    const passOf = (name: string) =>
      result.passes.find((pass) => pass.pass === name);

    expect(result.dryRun).toBe(true);
    expect(passOf("logs_floor")).toEqual({
      pass: "logs_floor",
      rows: 4200,
      budgetExhausted: false,
    });
    expect(passOf("logs_soft_deleted")).toEqual({
      pass: "logs_soft_deleted",
      rows: 12,
      budgetExhausted: false,
    });
    // Including the watermark: a dry run deleted nothing, so it must not claim
    // an organization has drained.
    expect(state.writes).toEqual([]);
    expect(state.transactions).toBe(0);
  });

  it("walks the output_raw pages and writes nothing in a dry run", async () => {
    // Its count cannot finish on a large table, so the dry run reads the same
    // pages a real run would. Nothing is removed, so only the cursor can carry
    // the walk to its end.
    state.selectPages = [
      ORG_ROWS,
      [], // watermarks
      [], // the free organization's workflows
      [
        { id: "log-1", at: "2025-08-01 10:00:00.000001" },
        { id: "log-2", at: "2025-08-01 10:00:00.000002" },
      ],
      [{ id: "log-3", at: "2025-08-01 10:00:00.000003" }],
    ];

    const result = await runRetentionPurge(
      enabledConfig({ dryRun: true, batchSize: 2 }),
      NOW
    );

    expect(result.passes.at(-1)).toEqual({
      pass: "output_raw",
      rows: 3,
      budgetExhausted: false,
    });
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
    // orgs, floor, watermarks, free group, soft-deleted, then the output_raw
    // page.
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [],
      [],
      [{ id: "log-9", at: "2026-08-01 10:00:00.000001" }],
    ];

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
    // Nothing until the run-row pass: orgs, floor, watermarks, free group,
    // soft-deleted, then one execution.
    state.selectPages = [
      ORG_ROWS,
      [],
      [watermarkRow(1)],
      [],
      [],
      [{ id: "exec-1" }],
    ];

    const result = await runRetentionPurge(
      enabledConfig({ executionsEnabled: true }),
      NOW
    );
    const executionPass = result.passes.find(
      (pass) => pass.pass === "executions_flat_window"
    );

    expect(executionPass?.rows).toBe(1);
    // One for the run row and its children, one for the plan-window pass
    // reading its skipped run under the tighter timeout.
    expect(state.transactions).toBe(2);
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
    // floor and run-row passes deliberately carry no such guard. One workflow,
    // so the plan-window pass reads its runs and applies the guard there.
    state.selectPages = [ORG_ROWS, [], [], [{ id: "wf-1" }]];

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

  it("reads an organization's runs a small chunk of its workflows at a time", async () => {
    // One join with a LIMIT is what the planner turned into a scan of the whole
    // step-log table for an organization with a very large number of workflows.
    const workflowRows = Array.from(
      { length: PLAN_WINDOW_WORKFLOW_CHUNK + 1 },
      (_, index) => ({ id: `wf-${index}` })
    );
    state.selectPages = [ORG_ROWS, [], [watermarkRow(1)], workflowRows];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(workflowChunkReads().map((ids) => ids.length)).toEqual([
      PLAN_WINDOW_WORKFLOW_CHUNK,
      1,
    ]);
  });

  it("prices sequential scans out of every chunk read", async () => {
    state.selectPages = [
      ORG_ROWS,
      [],
      [watermarkRow(1)],
      [{ id: "wf-1" }],
      [{ id: "exec-1" }],
      [{ id: "log-1" }],
    ];

    await runRetentionPurge(enabledConfig(), NOW);

    const settings = state.writes
      .filter((write) => write.op === "execute")
      .map((write) => JSON.stringify(write.table))
      .filter((statement) => statement.includes("enable_seqscan"));

    // The runs of the one workflow chunk, the page of step logs, the empty page
    // that ends the drain, and the skipped-run read, each in a short
    // transaction of its own.
    expect(settings).toHaveLength(4);
    expect(state.transactions).toBe(4);
    // The two reads whose plan can leave the per-workflow index carry the
    // tighter timeout, because a cancellation is how the drain learns its slice
    // is too wide. The step-log reads are keyed by run id and do not.
    expect(
      settings.filter((statement) => statement.includes("statement_timeout"))
    ).toHaveLength(2);
  });

  it("carries on past an organization that fails, then fails the run", async () => {
    // The first organization's read is refused. The second still drains and
    // every later pass still runs before the run reports the failure.
    state.selectPages = [
      [
        {
          organizationId: "org-a",
          plan: "free",
          tier: null,
          planOverrides: null,
        },
        {
          organizationId: "org-b",
          plan: "free",
          tier: null,
          planOverrides: null,
        },
        {
          organizationId: "org-ent",
          plan: "enterprise",
          tier: null,
          planOverrides: null,
        },
      ],
      [], // floor pass
      [watermarkRow(1, "org-b")], // watermarks
      new Error("relation does not exist"), // org-a workflows
      [], // org-b workflows
      [], // soft-delete pass
      [{ id: "log-9", at: "2026-08-01 10:00:00.000001" }], // output_raw pass
    ];

    const error = await runRetentionPurge(enabledConfig(), NOW).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(RetentionPurgeIncompleteError);
    const incomplete = error as RetentionPurgeIncompleteError;
    expect(incomplete.failedOrganizationIds).toEqual(["org-a"]);
    expect(incomplete.message).toContain("org-a");
    // org-b drained and claimed its cutoff; org-a claimed nothing at all.
    expect(state.watermarks).toEqual([FREE_CUTOFF]);
    expect(
      incomplete.result.passes.find((pass) => pass.pass === "output_raw")?.rows
    ).toBe(1);
  });

  it("halves the slice when one read finds too many runs, and resumes at that chunk", async () => {
    // A single unbounded read of a busy workflow held a whole year of runs in
    // one statement. The slice shrinks instead, and the chunks already read in
    // full over the wider slice are not read again for the narrower one.
    const workflowRows = Array.from(
      { length: PLAN_WINDOW_WORKFLOW_CHUNK + 1 },
      (_, index) => ({ id: `wf-${index}` })
    );
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [watermarkRow(1)], // watermarks: one initial slice left to walk
      workflowRows,
      [], // slice 1, first chunk
      OVERFLOW, // slice 1, second chunk: too many
      [], // halved slice, second chunk only
      [], // next slice, first chunk
      [], // next slice, second chunk
    ];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(workflowChunkReads().map((ids) => ids.length)).toEqual([
      PLAN_WINDOW_WORKFLOW_CHUNK,
      1,
      1,
      PLAN_WINDOW_WORKFLOW_CHUNK,
      1,
    ]);
    const middle = new Date(FREE_CUTOFF.getTime() - SLICE_MS / 2);
    expect(state.watermarks).toEqual([middle, FREE_CUTOFF]);
    // The runs of the read that overflowed were never acted on.
    expect(state.writes.filter((write) => write.op === "delete")).toEqual([]);
  });

  it("never reads a slice wider than the cap, however wide the range", async () => {
    // KEEP-1360: the slice used to be the whole remaining range, and the
    // doubling used to climb back to it. Over a range an organization's runs
    // cannot fill a page early in, the planner stops using
    // (workflow_id, started_at) and walks the global started_at index instead -
    // measured on prod at 3.4 s warm and past the pool timeout cold. The cap
    // makes that width unreachable rather than usually caught.
    state.selectPages = [ORG_ROWS, [], [watermarkRow(5)], [{ id: "wf-1" }]];

    await runRetentionPurge(enabledConfig(), NOW);

    const spans = sliceSpans();
    expect(spans).toHaveLength(5);
    expect(new Set(spans)).toEqual(new Set([SLICE_MS]));
    // And the walk still reaches the end of the range.
    expect(sliceReads().at(-1)?.[1]).toEqual(FREE_CUTOFF);
    expect(state.watermarks.at(-1)).toEqual(FREE_CUTOFF);
  });

  it("narrows the slice a read timed out on, and never widens back into it", async () => {
    // A cancelled read is how a slice too wide for the per-workflow index
    // announces itself. Halving alone would not be enough: the doubling after
    // the next drained slice would walk straight back into the width that was
    // just cancelled and spend the timeout again on every sparse stretch.
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [watermarkRow(2)], // two initial slices left to walk
      [{ id: "wf-1" }],
      cancelledRead(), // the first slice, at the initial width
    ];

    await runRetentionPurge(enabledConfig(), NOW);

    const half = SLICE_MS / 2;
    expect(sliceSpans()).toEqual([SLICE_MS, half, half, half, half]);
    // Narrowed, not abandoned: the organization still drains to its cutoff.
    expect(state.watermarks.at(-1)).toEqual(FREE_CUTOFF);
  });

  it("fails an organization whose reads keep timing out at the shortest slice", async () => {
    // Narrowing has the same floor halving does. Past it the drain refuses
    // rather than retrying a width that has already proved unanswerable.
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [
        {
          organizationId: "org-free",
          executionsPurgedThrough: new Date(
            FREE_CUTOFF.getTime() - PLAN_WINDOW_MIN_CEILING_MS * 1.5
          ),
        },
      ],
      [{ id: "wf-1" }],
      cancelledRead(), // an hour and a half
      cancelledRead(), // the floor itself
    ];

    const error = await runRetentionPurge(enabledConfig(), NOW).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(RetentionPurgeIncompleteError);
    expect(
      (error as RetentionPurgeIncompleteError).failedOrganizationIds
    ).toEqual(["org-free"]);
    expect(state.watermarks).toEqual([]);
  });

  it("fails an organization whose runs read is refused for any other reason", async () => {
    // Only a cancelled statement means "too wide". Everything else must still
    // stop the organization rather than be retried on a narrower slice.
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [watermarkRow(1)],
      [{ id: "wf-1" }],
      new Error("deadlock detected"),
    ];

    const error = await runRetentionPurge(enabledConfig(), NOW).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(RetentionPurgeIncompleteError);
    expect(
      (error as RetentionPurgeIncompleteError).failedOrganizationIds
    ).toEqual(["org-free"]);
    expect(sliceSpans()).toEqual([SLICE_MS]);
    expect(state.watermarks).toEqual([]);
  });

  it("reads the oldest still-resumable run once per slice, anchored at the organization's lower bound", async () => {
    // Per slice, and over [from, sliceEnd) rather than the slice: setPurgeWatermark
    // upserts with GREATEST, so a slice looking only at its own window would find
    // no skipped run, write its own sliceEnd, and carry the watermark past one an
    // earlier slice stopped at.
    state.selectPages = [ORG_ROWS, [], [watermarkRow(2)], [{ id: "wf-1" }]];

    await runRetentionPurge(enabledConfig(), NOW);

    const reads = resumableReads();
    const from = new Date(FREE_CUTOFF.getTime() - 2 * SLICE_MS);
    expect(state.oldestCalls).toBe(2);
    expect(reads).toEqual([
      [from, new Date(from.getTime() + SLICE_MS)],
      [from, FREE_CUTOFF],
    ]);
  });

  it("recovers the ceiling once enough slices drain with no cancellation", async () => {
    // A cancelled read is not proof of a planner flip, so the ceiling must be
    // able to climb back. Gated, so a width that really is bad costs one
    // re-probe per PLAN_WINDOW_CEILING_RECOVERY_SLICES slices, not one per slice.
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [watermarkRow(12)],
      [{ id: "wf-1" }],
      cancelledRead(), // the first slice, at the cap
    ];

    await runRetentionPurge(enabledConfig(), NOW);

    const half = SLICE_MS / 2;
    const spans = sliceSpans();
    expect(spans[0]).toBe(SLICE_MS);
    expect(spans.slice(1, 1 + PLAN_WINDOW_CEILING_RECOVERY_SLICES)).toEqual(
      Array.from({ length: PLAN_WINDOW_CEILING_RECOVERY_SLICES }, () => half)
    );
    // Back at the cap, not past it.
    expect(spans[1 + PLAN_WINDOW_CEILING_RECOVERY_SLICES]).toBe(SLICE_MS);
  });

  it("narrows the slice when the skipped-run read is cancelled, rather than failing the organization", async () => {
    // That read runs under the same bound as the runs read, so a cancellation
    // means the same thing: too wide. It must not cost the organization its run.
    state.selectPages = [ORG_ROWS, [], [watermarkRow(2)], [{ id: "wf-1" }]];
    state.oldest = [cancelledRead()];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    expect(planPass?.failedOrganizationIds).toBeUndefined();
    expect(sliceSpans()[0]).toBe(SLICE_MS);
    expect(sliceSpans()[1]).toBe(SLICE_MS / 2);
    // Narrowed, not abandoned: it still drains to the cutoff.
    expect(state.watermarks.at(-1)).toEqual(FREE_CUTOFF);
  });

  it("skips every organization behind the one the budget stopped, and every later group", async () => {
    // The consequence that makes a crawling organization worse than a slow one.
    // budgetExhausted breaks the organization loop (purge-executions.ts:511)
    // and then the group loop (:522), so one organization that cannot finish
    // takes every organization behind it down with it for that run -- and the
    // report says only "budgetExhausted", never which ones were skipped.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T03:48:00.000Z"));
    state.selectPages = [
      // Two organizations in the 7-day group, one in a 30-day group behind it.
      [
        {
          organizationId: "org-a",
          plan: "free",
          tier: null,
          planOverrides: null,
        },
        {
          organizationId: "org-b",
          plan: "free",
          tier: null,
          planOverrides: null,
        },
        {
          organizationId: "org-pro",
          plan: "pro",
          tier: null,
          planOverrides: { logRetentionDays: 30 },
        },
        {
          organizationId: "org-ent",
          plan: "enterprise",
          tier: null,
          planOverrides: null,
        },
      ],
      [], // floor pass
      [watermarkRow(1, "org-a"), watermarkRow(1, "org-b")], // 7-day group
      [{ id: "wf-a" }], // org-a's workflows
      () => {
        // org-a's only chunk read burns the whole budget.
        vi.setSystemTime(new Date("2026-09-07T04:00:00.000Z"));
        return [];
      },
    ];

    const result = await runRetentionPurge(
      enabledConfig({ maxRuntimeMs: 60_000 }),
      NOW
    );
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    expect(planPass?.budgetExhausted).toBe(true);
    // The 30-day group was never entered: the group loop broke, so its window
    // is absent from the report rather than present with zero rows.
    expect(planPass?.windows?.map((window) => window.retentionDays)).toEqual([
      7,
    ]);
    // And the 7-day group reports two organizations while only org-a was read.
    expect(planPass?.windows?.[0].organizationCount).toBe(2);
    expect(workflowChunkReads()).toEqual([["wf-a"]]);
  });

  it("keeps the watermark of the last drained slice when the budget runs out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T03:48:00.000Z"));
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [watermarkRow(1)], // watermarks
      [{ id: "wf-1" }],
      OVERFLOW, // whole range: too many
      [], // first half drains
      () => {
        // The second half finds work just as the budget runs out.
        vi.setSystemTime(new Date("2026-09-07T04:00:00.000Z"));
        return [{ id: "exec-1" }];
      },
    ];

    const result = await runRetentionPurge(
      enabledConfig({ maxRuntimeMs: 60_000 }),
      NOW
    );
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    expect(planPass?.budgetExhausted).toBe(true);
    expect(state.watermarks).toEqual([
      new Date(FREE_CUTOFF.getTime() - SLICE_MS / 2),
    ]);
  });

  it("counts the rows an organization deleted before it failed", async () => {
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [], // watermarks
      [{ id: "wf-1" }],
      [{ id: "exec-1" }],
      [{ id: "log-1" }, { id: "log-2" }], // deleted
      new Error("canceling statement due to statement timeout"),
    ];

    const error = await runRetentionPurge(enabledConfig(), NOW).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(RetentionPurgeIncompleteError);
    const planPass = (
      error as RetentionPurgeIncompleteError
    ).result.passes.find((pass) => pass.pass === "logs_plan_window");
    expect(planPass?.rows).toBe(2);
    expect(planPass?.windows).toEqual([
      { retentionDays: 7, organizationCount: 1, rows: 2 },
    ]);
    // No slice finished, so nothing is claimed.
    expect(state.watermarks).toEqual([]);
  });

  it("fails an organization whose runs still overflow the shortest slice", async () => {
    // Halving has a floor. Past it the drain refuses rather than reading an
    // unbounded set.
    state.selectPages = [
      ORG_ROWS,
      [], // floor pass
      [
        {
          organizationId: "org-free",
          executionsPurgedThrough: new Date(
            FREE_CUTOFF.getTime() - PLAN_WINDOW_MIN_SLICE_MS * 1.5
          ),
        },
      ],
      [{ id: "wf-1" }],
      OVERFLOW, // one and a half seconds
      OVERFLOW, // the shortest slice
    ];

    const error = await runRetentionPurge(enabledConfig(), NOW).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(RetentionPurgeIncompleteError);
    expect(
      (error as RetentionPurgeIncompleteError).failedOrganizationIds
    ).toEqual(["org-free"]);
    expect(state.watermarks).toEqual([]);
  });

  it("walks the same bounded reads in a dry run and counts instead of deleting", async () => {
    // The dry run used to count with one join per organization, the query
    // shape that cannot finish on a production-sized table.
    state.selectPages = [
      ORG_ROWS,
      [watermarkRow(1)], // watermarks (a dry run's floor pass counts, it does not page)
      [{ id: "wf-1" }],
      [{ id: "exec-1" }, { id: "exec-2" }],
    ];
    // The floor pass, the step logs of those two runs, then the soft-delete pass.
    state.counts = [0, 7, 0];

    const result = await runRetentionPurge(
      enabledConfig({ dryRun: true }),
      NOW
    );
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    expect(planPass?.rows).toBe(7);
    expect(state.watermarks).toEqual([]);
    // Only the planner settings of the two reads; nothing deleted or claimed.
    expect(state.writes.every((write) => write.op === "execute")).toBe(true);
    expect(state.transactions).toBe(2);
  });

  it("counts every other pass before an output_raw walk the budget stops", async () => {
    // The output_raw dry run walks pages, and a walk makes no progress from one
    // dry run to the next, so on a large backlog it runs out of time every
    // time. Every pass that counts runs ahead of it and still reports.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T03:48:00.000Z"));
    state.selectPages = [
      ORG_ROWS,
      [], // watermarks
      [], // the free organization's workflows
      () => {
        // The first output_raw page comes back just as the budget runs out.
        vi.setSystemTime(new Date("2026-09-07T04:00:00.000Z"));
        return [
          { id: "log-1", at: "2025-08-01 10:00:00.000001" },
          { id: "log-2", at: "2025-08-01 10:00:00.000002" },
        ];
      },
    ];
    state.counts = [5, 3, 1]; // floor, soft-delete, run rows

    const result = await runRetentionPurge(
      enabledConfig({
        dryRun: true,
        executionsEnabled: true,
        batchSize: 2,
        maxRuntimeMs: 60_000,
      }),
      NOW
    );

    expect(
      result.passes.map((pass) => [pass.pass, pass.rows, pass.budgetExhausted])
    ).toEqual([
      ["logs_floor", 5, false],
      ["logs_plan_window", 0, false],
      ["logs_soft_deleted", 3, false],
      ["executions_flat_window", 1, false],
      ["output_raw", 2, true],
    ]);
    expect(state.writes).toEqual([]);
  });
});
