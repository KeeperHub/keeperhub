/**
 * KEEP-1042: control flow of the retention purge. The drizzle builder and every
 * operator are stubbed, so this asserts what the job DOES -- which passes run,
 * in what order, when it stops, and what a dry run is allowed to touch -- not
 * the SQL it emits. The SQL is exercised against a real database in staging
 * with EXECUTION_RETENTION_DRY_RUN on before the job is enabled for real.
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
    notInArray: marker("notInArray"),
  };
});

vi.mock("@/lib/db/schema", () => ({
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
  getPlanLimits: () => ({ logRetentionDays: 7 }),
  parsePlanName: (value: unknown) => value ?? "free",
  parseTierKey: () => null,
}));

// Hoisted with the vi.mock factories: the module under test imports `db` at
// load time, which happens before any top-level statement in this file runs.
const { state, dbStub } = vi.hoisted(() => {
  const hoistedState = {
    /** Pages returned by successive awaited selects, oldest first. */
    selectPages: [] as Array<Array<{ id: string }>>,
    selectCalls: 0,
    writes: [] as Array<{ op: "delete" | "update"; table: unknown }>,
    /** Predicates handed to every select, in call order. */
    wheres: [] as unknown[],
    transactions: 0,
  };

  function makeSelectBuilder() {
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
      resolve: (rows: Array<{ id: string }>) => unknown,
      reject?: (error: unknown) => unknown
    ) => {
      try {
        const page = hoistedState.selectPages[hoistedState.selectCalls] ?? [];
        hoistedState.selectCalls += 1;
        return Promise.resolve(resolve(page));
      } catch (error) {
        return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
      }
    };
    return builder;
  }

  function makeWriteBuilder(op: "delete" | "update", table: unknown) {
    const builder: Record<string, unknown> = {};
    builder.set = () => builder;
    builder.where = () => {
      hoistedState.writes.push({ op, table });
      return Promise.resolve();
    };
    return builder;
  }

  const hoistedDb: Record<string, unknown> = {
    select: () => makeSelectBuilder(),
    delete: (table: unknown) => makeWriteBuilder("delete", table),
    update: (table: unknown) => makeWriteBuilder("update", table),
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

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return { ...getRetentionConfig(), enabled: true, ...overrides };
}

beforeEach(() => {
  state.selectPages = [];
  state.selectCalls = 0;
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

    expect(result).toEqual({
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
    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.passes.map((pass) => pass.pass)).toEqual([
      "logs_floor",
      "logs_plan_window",
      "output_raw",
      "logs_soft_deleted",
      "executions_flat_window",
    ]);
    expect(result.enabled).toBe(true);
  });

  it("deletes a page, then stops when the next page is empty", async () => {
    state.selectPages = [[{ id: "log-1" }, { id: "log-2" }]];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const floorPass = result.passes.find((pass) => pass.pass === "logs_floor");

    expect(floorPass).toEqual({
      pass: "logs_floor",
      rows: 2,
      budgetExhausted: false,
    });
    expect(state.writes[0]).toEqual({ op: "delete", table: { id: "logs.id" } });
  });

  it("reports the first eligible page and writes nothing in a dry run", async () => {
    state.selectPages = [[{ id: "log-1" }, { id: "log-2" }, { id: "log-3" }]];

    const result = await runRetentionPurge(
      enabledConfig({ dryRun: true }),
      NOW
    );

    expect(result.dryRun).toBe(true);
    expect(result.passes[0]).toEqual({
      pass: "logs_floor",
      rows: 3,
      budgetExhausted: false,
    });
    expect(state.writes).toEqual([]);
    expect(state.transactions).toBe(0);
  });

  it("stops on the runtime budget instead of overlapping the next run", async () => {
    // Endless work: every select returns a full page, so only the budget can
    // end the pass.
    state.selectPages = new Proxy([] as Array<Array<{ id: string }>>, {
      get: (_target, prop) =>
        prop === "length" ? Number.MAX_SAFE_INTEGER : [{ id: "log-1" }],
    });

    const result = await runRetentionPurge(
      enabledConfig({ maxRuntimeMs: 0 }),
      NOW
    );

    expect(result.passes.every((pass) => pass.budgetExhausted)).toBe(true);
    expect(state.writes).toEqual([]);
  });

  it("nulls output_raw with an UPDATE rather than deleting the row", async () => {
    // Pass 1 and pass 2 find nothing, pass 3 finds one page.
    state.selectPages = [[], [], [{ id: "log-9" }]];

    const result = await runRetentionPurge(enabledConfig(), NOW);

    expect(result.passes.find((pass) => pass.pass === "output_raw")?.rows).toBe(
      1
    );
    expect(state.writes).toContainEqual({
      op: "update",
      table: { id: "logs.id" },
    });
  });

  it("skips a run that can still resume in both short-window passes", async () => {
    // The plan window can be as short as 7 days, and a resumable run's step
    // logs carry the output_raw the executor reads to pick it back up. The
    // 400-day floor and flat passes deliberately carry no such guard.
    state.selectPages = [[], [{ id: "org-a" }], [], [], [], [], []];

    await runRetentionPurge(enabledConfig(), NOW);

    const guards = state.wheres.flatMap((where) =>
      findMarkers(where, "notInArray")
    );
    const statusGuards = guards.filter(
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

  it("retires a run row and its children in one transaction", async () => {
    // Only the last pass finds anything: four empty pages, then one execution.
    state.selectPages = [[], [], [], [], [{ id: "exec-1" }]];

    const result = await runRetentionPurge(enabledConfig(), NOW);
    const executionPass = result.passes.find(
      (pass) => pass.pass === "executions_flat_window"
    );

    expect(executionPass?.rows).toBe(1);
    expect(state.transactions).toBe(1);
    // Children first: nothing cascades, so a parent delete with a surviving
    // child simply fails.
    expect(state.writes.map((write) => write.table)).toEqual([
      { id: "logs.id" },
      {},
      { id: "executions.id" },
    ]);
  });
});
