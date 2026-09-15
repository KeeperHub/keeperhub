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
    // sql doubles as a namespace: the watermark backfill binds its timestamp
    // through sql.param, because postgres.js has no encoder for a bare Date.
    sql: Object.assign(marker("sql"), {
      param: marker("param"),
      join: marker("join"),
      raw: marker("raw"),
    }),
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
    /** Counts returned to the plan-window dry run's per-page measure. */
    counts: [] as number[],
    countCalls: 0,
    /** Instants handed to setPurgeWatermarks, in call order. */
    watermarks: [] as unknown[],
    /** Organizations whose subscription changed inside the grace. */
    changed: [] as string[],
    writes: [] as Array<{ op: string; table: unknown }>,
    /** Predicates handed to every select, in call order. */
    wheres: [] as unknown[],
    transactions: 0,
    /** Reject the write of kind `op` once `after` of them have succeeded. */
    failOn: null as { op: string; after: number } | null,
    /** Reject every raw statement, such as the floor watermark backfill. */
    failExecute: false,
    /**
     * Rows returned by successive raw statements -- the backfill, then probes.
     * An Error in a slot rejects that statement instead.
     */
    executeResults: [] as Array<unknown[] | Error>,
    executeCalls: 0,
    /** The id list of every delete, in call order. */
    deletedIds: [] as unknown[],
  };

  // The aggregate selects -- the dry-run measure and the plan-change lookup --
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
    builder.values = (
      rows: Record<string, unknown> | Record<string, unknown>[]
    ) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        hoistedState.watermarks.push(row?.executionsPurgedThrough);
      }
      return builder;
    };
    builder.onConflictDoUpdate = () => {
      hoistedState.writes.push({ op, table });
      return Promise.resolve();
    };
    builder.where = (predicate: unknown) => {
      const done = hoistedState.writes.filter((write) => write.op === op);
      const failOn = hoistedState.failOn;
      if (failOn && failOn.op === op && done.length >= failOn.after) {
        return Promise.reject(
          Object.assign(new Error("Failed query: update"), {
            cause: new Error("canceling statement due to statement timeout"),
          })
        );
      }
      hoistedState.writes.push({ op, table });
      // A write resolves to the rows it touched, as postgres.js reports them.
      const ids = (predicate as { args?: unknown[] } | undefined)?.args?.[1];
      if (op === "delete") {
        hoistedState.deletedIds.push(ids);
      }
      return Promise.resolve({ count: Array.isArray(ids) ? ids.length : 0 });
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
      // Session settings such as SET LOCAL answer nothing and take no slot.
      if ((statement as { kind?: string } | undefined)?.kind === "raw") {
        return Promise.resolve([]);
      }
      if (hoistedState.failExecute) {
        return Promise.reject(
          new Error("canceling statement due to statement timeout")
        );
      }
      hoistedState.writes.push({ op: "execute", table: statement });
      const rows = hoistedState.executeResults[hoistedState.executeCalls] ?? [];
      hoistedState.executeCalls += 1;
      return rows instanceof Error
        ? Promise.reject(rows)
        : Promise.resolve(rows);
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

/** A plan-window page row: a run, its organization and its status. */
function run(
  id: string,
  startedAt: string,
  organizationId: string,
  status = "success"
) {
  return {
    id,
    at: startedAt.replace("T", " ").replace("Z", ""),
    startedAt: new Date(startedAt),
    organizationId,
    status,
  };
}

beforeEach(() => {
  state.selectPages = [];
  state.selectCalls = 0;
  state.counts = [];
  state.countCalls = 0;
  state.watermarks = [];
  state.changed = [];
  state.writes = [];
  state.wheres = [];
  state.transactions = 0;
  state.failOn = null;
  state.failExecute = false;
  state.executeResults = [];
  state.executeCalls = 0;
  state.deletedIds = [];
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
    // orgs, floor pass, watermarks, then the 7-day window's first page.
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [run("run-1", "2026-08-01T00:00:00.000Z", "org-free")],
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
      [run("run-1", "2026-08-01T00:00:00.000Z", "org-free")],
    ];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(state.writes).toContainEqual({
      op: "insert",
      table: { id: "progress" },
    });
  });

  it("stops the watermark at the oldest run it had to skip", async () => {
    // The walk passes over a run that can still resume. Advancing to the
    // cutoff would move the lower bound past it and, because the bound is
    // inclusive below, it would never be walked again -- a run that is phantom
    // today and succeeds tomorrow would keep its step logs until the floor pass.
    const skipped = "2026-08-18T12:00:00.000Z";
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [
        run("run-phantom", skipped, "org-free", "phantom"),
        run("run-later", "2026-08-20T12:00:00.000Z", "org-free"),
      ],
    ];

    await runRetentionPurge(enabledConfig(), NOW);

    expect(state.watermarks).toEqual([new Date(skipped)]);
    // Only the finished run's logs go; the resumable one is not in the delete.
    expect(state.deletedIds).toEqual([["run-later"]]);
  });

  describe("an organization behind the window's front", () => {
    // Two organizations on the 7-day window. org-free has walked up to the
    // front; org-new has no watermark of its own, so it starts at the floor
    // cutoff, the way every new organization does.
    const TWO_FREE_ORGS = [
      ORG_ROWS[0],
      {
        organizationId: "org-new",
        plan: "free",
        tier: null,
        planOverrides: null,
      },
      ORG_ROWS[1],
    ];
    const FRONT = new Date("2026-08-30T12:00:00.000Z");
    const FLOOR_CUTOFF = new Date("2025-09-07T12:00:00.000Z");
    const CUTOFF = new Date("2026-08-31T12:00:00.000Z");

    function walkLowerBounds(): unknown[] {
      return state.wheres
        .flatMap((where) => findMarkers(where, "gte"))
        .map((bound) => bound.args[1]);
    }

    it("does not send the walk back to the floor when it has nothing there", async () => {
      state.selectPages = [
        TWO_FREE_ORGS,
        [],
        [{ organizationId: "org-free", executionsPurgedThrough: FRONT }],
        [],
      ];
      // The backfill, then the probe for org-new: no run with logs, no pin.
      state.executeResults = [[], [{ work: null, pinned: null }]];

      await runRetentionPurge(enabledConfig(), NOW);

      expect(walkLowerBounds()).toContainEqual(FRONT);
      expect(walkLowerBounds()).not.toContainEqual(FLOOR_CUTOFF);
      expect(state.watermarks).toEqual([CUTOFF, CUTOFF]);
    });

    it("starts it at its oldest run with step logs, and pins it at its stuck run", async () => {
      state.selectPages = [
        TWO_FREE_ORGS,
        [],
        [{ organizationId: "org-free", executionsPurgedThrough: FRONT }],
        [],
      ];
      state.executeResults = [
        [],
        [
          {
            work: "2026-06-01 00:00:00.5",
            pinned: "2026-05-01 00:00:00.123456",
          },
        ],
      ];

      await runRetentionPurge(enabledConfig(), NOW);

      expect(walkLowerBounds()).toContainEqual(
        new Date("2026-06-01T00:00:00.500Z")
      );
      // The pin is cut to the millisecond, never rounded up.
      expect(state.watermarks).toEqual([
        CUTOFF,
        new Date("2026-05-01T00:00:00.123Z"),
      ]);
    });

    it("walks it from its own watermark when the probe times out", async () => {
      state.selectPages = [
        TWO_FREE_ORGS,
        [],
        [{ organizationId: "org-free", executionsPurgedThrough: FRONT }],
        [],
      ];
      state.executeResults = [
        [],
        Object.assign(new Error("Failed query: SELECT"), {
          cause: Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: "57014" }
          ),
        }),
      ];

      const result = await runRetentionPurge(enabledConfig(), NOW);

      // Slower, but still correct, and the run carries on.
      expect(walkLowerBounds()).toContainEqual(FLOOR_CUTOFF);
      expect(result.failedPass).toBeUndefined();
      expect(state.watermarks).toEqual([CUTOFF, CUTOFF]);
    });

    it("fails the pass on a probe error that is not a timeout", async () => {
      state.selectPages = [
        TWO_FREE_ORGS,
        [],
        [{ organizationId: "org-free", executionsPurgedThrough: FRONT }],
      ];
      state.executeResults = [[], new Error("connection terminated")];

      const result = await runRetentionPurge(enabledConfig(), NOW);

      expect(result.failedPass).toBe("logs_plan_window");
      expect(
        result.passes.find((pass) => pass.pass === "logs_plan_window")?.error
      ).toContain("connection terminated");
    });
  });

  it("passes over a run whose organization is on another window", async () => {
    // No organization filter in the query, so the check in code is the only
    // thing between an enterprise run and the 7-day cutoff.
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [
        run("run-ent", "2026-08-01T00:00:00.000Z", "org-ent"),
        run("run-unknown", "2026-08-02T00:00:00.000Z", "org-gone"),
      ],
    ];

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(
      result.passes.find((pass) => pass.pass === "logs_plan_window")?.rows
    ).toBe(0);
    expect(state.writes.filter((write) => write.op === "delete")).toEqual([]);
  });

  it("records how far the walk got when a later page fails", async () => {
    // The first page's delete commits, the second hits the statement timeout.
    // The next run must continue after the first page, not start over.
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [run("run-1", "2026-08-01T00:00:00.000Z", "org-free")],
      [run("run-2", "2026-08-02T00:00:00.000Z", "org-free")],
    ];
    state.failOn = { op: "delete", after: 1 };

    const result = await runRetentionPurge(
      enabledConfig({ batchSize: 10 }),
      NOW
    );
    const planPass = result.passes.find(
      (pass) => pass.pass === "logs_plan_window"
    );

    expect(result.failedPass).toBe("logs_plan_window");
    expect(planPass).toMatchObject({ rows: 1, budgetExhausted: false });
    expect(state.watermarks).toEqual([new Date("2026-08-01T00:00:00.000Z")]);
  });

  it("keeps the rows a pass removed when the watermark backfill fails", async () => {
    // The floor pass deletes a page, then advancing the watermarks times out.
    // The rows are gone either way, so the result has to still say so.
    state.selectPages = [
      ORG_ROWS,
      [{ id: "log-1", at: "2025-01-01 00:00:00.000001" }],
    ];
    state.failExecute = true;

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.failedPass).toBe("logs_floor");
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]).toMatchObject({ pass: "logs_floor", rows: 1 });
    expect(result.passes[0].error).toContain("statement timeout");
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
    state.selectPages = [ORG_ROWS, [], [], []];

    await runRetentionPurge(enabledConfig(), NOW);

    // org-free is on the 7-day window; org-ent sits at the floor and never
    // enters the per-organization pass.
    expect(state.watermarks).toEqual([new Date("2026-08-31T12:00:00.000Z")]);
  });

  it("walks the same pages in a dry run and writes nothing", async () => {
    // Pages, not a count: a count over the whole table is a full scan of the
    // step-log table on prod. The cursor still moves without a write, so the
    // walk ends, and a batch below the work shows it does not stop at one page.
    state.selectPages = [
      ORG_ROWS,
      [
        { id: "log-1", at: "2025-01-01 00:00:00.000001" },
        { id: "log-2", at: "2025-01-02 00:00:00.000002" },
      ],
      [{ id: "log-3", at: "2025-01-03 00:00:00.000003" }],
    ];

    const result = await runRetentionPurge(
      enabledConfig({ dryRun: true, batchSize: 2 }),
      NOW
    );

    expect(result.dryRun).toBe(true);
    expect(result.passes[0]).toEqual({
      pass: "logs_floor",
      rows: 3,
      budgetExhausted: false,
    });
    // Including the watermark: a dry run deleted nothing, so it must not claim
    // an organization has drained.
    expect(state.writes).toEqual([]);
    expect(state.transactions).toBe(0);
  });

  it("starts each page after the last row of the page before", async () => {
    // Without the cursor every page went back over the rows the pages before
    // it had cleared, and on prod that is a sequential scan per page.
    const lastOfFirstPage = "2025-01-02 00:00:00.000002";
    state.selectPages = [
      ORG_ROWS,
      [
        { id: "log-1", at: "2025-01-01 00:00:00.000001" },
        { id: "log-2", at: lastOfFirstPage },
      ],
    ];

    await runRetentionPurge(enabledConfig({ batchSize: 2 }), NOW);

    // The cursor is bound as the text Postgres printed, microseconds and all.
    const boundValues = state.wheres
      .flatMap((where) => findMarkers(where, "sql"))
      .flatMap((fragment) => fragment.args);
    expect(boundValues).toContain(lastOfFirstPage);
  });

  it("reports what a pass removed before a page failed, and stops the run", async () => {
    // orgs, floor, watermarks, free group, then two output_raw pages: the
    // first update commits, the second hits the statement timeout.
    state.selectPages = [
      ORG_ROWS,
      [],
      [],
      [],
      [{ id: "log-1", at: "2026-08-01 00:00:00.000001" }],
      [{ id: "log-2", at: "2026-08-02 00:00:00.000002" }],
    ];
    state.failOn = { op: "update", after: 1 };

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const outputRaw = result.passes.find((pass) => pass.pass === "output_raw");

    expect(result.failedPass).toBe("output_raw");
    expect(outputRaw).toMatchObject({ rows: 1, budgetExhausted: false });
    expect(outputRaw?.error).toContain(
      "canceling statement due to statement timeout"
    );
    expect(result.passes.map((pass) => pass.pass)).toEqual([
      "logs_floor",
      "logs_plan_window",
      "output_raw",
    ]);
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

  it("keeps the resumable guard in the output_raw query", async () => {
    // A resumable run's step logs carry the output_raw the executor reads to
    // pick it back up. The plan-window pass makes the same check in code (see
    // "stops the watermark at the oldest run it had to skip"); the floor and
    // run-row passes deliberately carry no such guard.
    state.selectPages = [ORG_ROWS];

    await runRetentionPurge(enabledConfig(), NOW);

    const statusGuards = state.wheres
      .flatMap((where) => findMarkers(where, "notInArray"))
      .filter(
        (guard) =>
          Array.isArray(guard.args[1]) &&
          (guard.args[1] as string[]).includes("running")
      );

    expect(statusGuards.length).toBeGreaterThanOrEqual(1);
    expect(statusGuards[0].args[1]).toEqual([
      "pending",
      "running",
      "phantom",
      "unconfirmed",
    ]);
  });
});
