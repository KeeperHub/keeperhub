/**
 * Control flow of the DevKit run retention job. The drizzle builder and every
 * operator are stubbed, so this asserts what the job DOES -- when it touches
 * the database at all, what a dry run may do, the order of the deletes inside
 * each batch, and when it stops -- not the SQL it emits. The SQL is exercised
 * against a real database in tests/db/devkit-retention-purge.db.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("drizzle-orm", () => {
  const marker =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    and: marker("and"),
    asc: marker("asc"),
    count: marker("count"),
    inArray: marker("inArray"),
    lt: marker("lt"),
  };
});

vi.mock("@/lib/retention/devkit-tables", () => ({
  devkitRuns: {
    table: "runs",
    id: "runs.id",
    status: "runs.status",
    createdAt: "runs.created_at",
  },
  devkitSteps: {
    table: "steps",
    stepId: "steps.step_id",
    runId: "steps.run_id",
  },
  devkitEvents: { table: "events", id: "events.id", runId: "events.run_id" },
}));

const { state, dbStub } = vi.hoisted(() => {
  const hoistedState = {
    /** Pages returned by successive batch selects, in call order. */
    pages: [] as Array<Array<{ id: string }>>,
    selectCalls: 0,
    /** Limits handed to the batch select, in call order. */
    limits: [] as number[],
    count: 0,
    countCalls: 0,
    /** Rows each child delete reports, keyed by table. */
    deletedPerBatch: { events: 0, steps: 0 },
    /** Every delete, in order, with the ids it was scoped to. */
    deletes: [] as Array<{ table: string; ids: unknown }>,
    transactions: 0,
    failTransaction: false,
  };

  function makeSelectBuilder(projection?: Record<string, unknown>) {
    const isCount = projection !== undefined && "n" in projection;
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy"]) {
      builder[method] = () => builder;
    }
    builder.limit = (limit: number) => {
      hoistedState.limits.push(limit);
      return builder;
    };
    // biome-ignore lint/suspicious/noThenProperty: the builder under test is awaited directly
    builder.then = (resolve: (rows: unknown[]) => unknown) => {
      if (isCount) {
        hoistedState.countCalls += 1;
        return Promise.resolve(resolve([{ n: hoistedState.count }]));
      }
      const page = hoistedState.pages[hoistedState.selectCalls] ?? [];
      hoistedState.selectCalls += 1;
      return Promise.resolve(resolve(page));
    };
    return builder;
  }

  function makeDeleteBuilder(table: { table: string }) {
    return {
      where: (predicate: { args: unknown[] }) => {
        hoistedState.deletes.push({
          table: table.table,
          ids: predicate.args[1],
        });
        const size =
          table.table === "events" || table.table === "steps"
            ? hoistedState.deletedPerBatch[table.table]
            : 0;
        const rows = Array.from({ length: size }, (_, i) => ({ id: `${i}` }));
        const result = Promise.resolve(rows);
        return Object.assign(result, { returning: () => result });
      },
    };
  }

  const hoistedDb = {
    select: (projection?: Record<string, unknown>) =>
      makeSelectBuilder(projection),
    delete: (table: { table: string }) => makeDeleteBuilder(table),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      hoistedState.transactions += 1;
      const result = await callback(hoistedDb);
      if (hoistedState.failTransaction) {
        throw new Error("could not serialize access");
      }
      return result;
    },
  };

  return { state: hoistedState, dbStub: hoistedDb };
});

vi.mock("@/lib/db", () => ({ db: dbStub }));

import type { DevkitRetentionConfig } from "@/lib/retention/devkit-config";
import { runDevkitRetentionPurge } from "@/lib/retention/purge-devkit-runs";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function config(
  overrides: Partial<DevkitRetentionConfig> = {}
): DevkitRetentionConfig {
  return {
    enabled: true,
    dryRun: false,
    retentionDays: 30,
    batchSize: 2,
    maxRuntimeMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  state.pages = [];
  state.selectCalls = 0;
  state.limits = [];
  state.count = 0;
  state.countCalls = 0;
  state.deletedPerBatch = { events: 0, steps: 0 };
  state.deletes = [];
  state.transactions = 0;
  state.failTransaction = false;
});

describe("runDevkitRetentionPurge", () => {
  it("touches nothing while the job is switched off", async () => {
    const result = await runDevkitRetentionPurge(
      config({ enabled: false }),
      NOW
    );

    expect(result).toEqual({
      enabled: false,
      dryRun: false,
      retentionDays: 30,
      durationMs: 0,
      runs: 0,
      steps: 0,
      events: 0,
      budgetExhausted: false,
    });
    expect(state.selectCalls).toBe(0);
    expect(state.countCalls).toBe(0);
    expect(state.transactions).toBe(0);
  });

  it("reports the eligible count on a dry run and deletes nothing", async () => {
    state.count = 1234;

    const result = await runDevkitRetentionPurge(config({ dryRun: true }), NOW);

    expect(result).toMatchObject({
      enabled: true,
      dryRun: true,
      runs: 1234,
      steps: 0,
      events: 0,
      budgetExhausted: false,
    });
    expect(state.selectCalls).toBe(0);
    expect(state.transactions).toBe(0);
    expect(state.deletes).toEqual([]);
  });

  it("deletes events, then steps, then runs, one transaction per batch", async () => {
    state.pages = [[{ id: "wrun_a" }, { id: "wrun_b" }], [{ id: "wrun_c" }]];
    state.deletedPerBatch = { events: 15, steps: 4 };

    const result = await runDevkitRetentionPurge(config(), NOW);

    expect(result).toMatchObject({
      runs: 3,
      events: 30,
      steps: 8,
      budgetExhausted: false,
    });
    expect(state.transactions).toBe(2);
    expect(state.deletes).toEqual([
      { table: "events", ids: ["wrun_a", "wrun_b"] },
      { table: "steps", ids: ["wrun_a", "wrun_b"] },
      { table: "runs", ids: ["wrun_a", "wrun_b"] },
      { table: "events", ids: ["wrun_c"] },
      { table: "steps", ids: ["wrun_c"] },
      { table: "runs", ids: ["wrun_c"] },
    ]);
    // Drained: the third select came back empty.
    expect(state.selectCalls).toBe(3);
    expect(state.limits).toEqual([2, 2, 2]);
  });

  it("stops before the first batch when the budget is already spent", async () => {
    state.pages = [[{ id: "wrun_a" }]];

    const result = await runDevkitRetentionPurge(
      config({ maxRuntimeMs: 0 }),
      NOW
    );

    expect(result).toMatchObject({ runs: 0, budgetExhausted: true });
    expect(state.selectCalls).toBe(0);
    expect(state.transactions).toBe(0);
  });

  it("stops a dry run too when the budget is already spent", async () => {
    state.count = 99;

    const result = await runDevkitRetentionPurge(
      config({ dryRun: true, maxRuntimeMs: 0 }),
      NOW
    );

    expect(result).toMatchObject({ runs: 0, budgetExhausted: true });
    expect(state.countCalls).toBe(0);
  });

  it("fails the run when a batch fails, without selecting another page", async () => {
    state.pages = [[{ id: "wrun_a" }], [{ id: "wrun_b" }]];
    state.failTransaction = true;

    await expect(runDevkitRetentionPurge(config(), NOW)).rejects.toThrow(
      "could not serialize access"
    );
    expect(state.selectCalls).toBe(1);
  });
});
