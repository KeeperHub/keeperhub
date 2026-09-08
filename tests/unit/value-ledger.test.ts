import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/utils/id", () => ({ generateId: () => "res_gen" }));

// Hoisted state the fake db reads from / writes to, set per test.
const state = vi.hoisted(() => ({
  caps: [] as Array<{
    dailyValueCapWei: string | null;
    dailySolanaValueCapLamports?: string | null;
  }>,
  directSum: [{ totalWei: "0" }] as Array<{ totalWei: string }>,
  ledgerSum: [{ totalWei: "0" }] as Array<{ totalWei: string }>,
  directLamportsSum: [{ totalLamports: "0" }] as Array<{
    totalLamports: string;
  }>,
  ledgerLamportsSum: [{ totalLamports: "0" }] as Array<{
    totalLamports: string;
  }>,
  inserted: [] as Record<string, unknown>[],
  capAnchors: [] as Record<string, unknown>[],
  capInsertLosesRace: false,
  updates: [] as Record<string, unknown>[],
  returningId: "res_1",
  reserveKind: "evm" as "evm" | "solana",
  // Org circuit-breaker state served to isOrgHalted's read. Null = not halted.
  orgHaltedAt: null as Date | null,
}));

// A cap-row insert carries nothing but the org id: lockOrgSpendCapRow creates
// the row purely as a lock anchor, with both cap columns left NULL.
function isCapAnchorInsert(values: Record<string, unknown>): boolean {
  return Object.keys(values).length === 1 && "organizationId" in values;
}

// Fake db: transaction whose tx serves the cap FOR UPDATE lookup (recognised by
// the selected columns, since lockOrgSpendCapRow may run it twice), the anchor
// insert when the org has no row, the two SUM selects (direct executions, then
// the value ledger) that sumOrgValueTodayWei runs, and the reservation insert
// (.returning). update() records the settle/release status.
vi.mock("@/lib/db", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => {
      let sumCall = 0;
      const tx = {
        select: (fields: Record<string, unknown>) => {
          const columns = Object.keys(fields ?? {});
          if (
            columns.includes("dailyValueCapWei") ||
            columns.includes("dailySolanaValueCapLamports")
          ) {
            return {
              from: () => ({
                where: () => ({
                  for: () => ({
                    limit: () => Promise.resolve(state.caps),
                  }),
                }),
              }),
            };
          }
          // isOrgHalted's read: runs first in the transaction. Not counted as a
          // SUM call so the two cap SUM selects keep their call ordering.
          if (columns.includes("haltedAt")) {
            return {
              from: () => ({
                where: () => ({
                  limit: () =>
                    Promise.resolve([{ haltedAt: state.orgHaltedAt }]),
                }),
              }),
            };
          }
          sumCall += 1;
          let rows: Array<{ totalWei: string } | { totalLamports: string }>;
          if (sumCall === 1) {
            rows =
              state.reserveKind === "solana"
                ? state.directLamportsSum
                : state.directSum;
          } else {
            rows =
              state.reserveKind === "solana"
                ? state.ledgerLamportsSum
                : state.ledgerSum;
          }
          return {
            from: () => ({ where: () => Promise.resolve(rows) }),
          };
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            if (isCapAnchorInsert(v)) {
              state.capAnchors.push(v);
              return {
                // onConflictDoNothing yields a row only when the insert
                // actually happened. `capInsertLosesRace` models a concurrent
                // transaction having created the row first, where postgres
                // returns nothing and the row still exists to be locked.
                onConflictDoNothing: () => ({
                  returning: () => {
                    state.caps = [
                      {
                        dailyValueCapWei: null,
                        dailySolanaValueCapLamports: null,
                      },
                    ];
                    return Promise.resolve(
                      state.capInsertLosesRace
                        ? []
                        : [{ organizationId: "org_1" }]
                    );
                  },
                }),
              };
            }
            state.inserted.push(v);
            return {
              returning: () => Promise.resolve([{ id: state.returningId }]),
            };
          },
        }),
      };
      return cb(tx);
    },
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(s);
          return Promise.resolve(undefined);
        },
      }),
    }),
  },
}));

import { ORG_HALTED_REASON } from "@/lib/execute/org-circuit-breaker";
import {
  getDefaultDailySolanaValueCapLamports,
  getDefaultDailyValueCapWei,
} from "@/lib/execute/spend-cap-defaults";
import {
  reserveOrgSolanaValue,
  reserveOrgValue,
  withSolanaValueCap,
  withStepValueCap,
  withValueCap,
} from "@/lib/execute/value-ledger";

const ONE_ETH_WEI = "1000000000000000000";
const ONE_SOL_LAMPORTS = "1000000000";
const DEFAULT_WEI = BigInt(getDefaultDailyValueCapWei());
const DEFAULT_LAMPORTS = BigInt(getDefaultDailySolanaValueCapLamports());

beforeEach(() => {
  state.caps = [];
  state.directSum = [{ totalWei: "0" }];
  state.ledgerSum = [{ totalWei: "0" }];
  state.directLamportsSum = [{ totalLamports: "0" }];
  state.ledgerLamportsSum = [{ totalLamports: "0" }];
  state.inserted = [];
  state.capAnchors = [];
  state.capInsertLosesRace = false;
  state.updates = [];
  state.returningId = "res_1";
  state.reserveKind = "evm";
  state.orgHaltedAt = null;
});

describe("reserveOrgValue", () => {
  it("applies the platform default when no cap row exists", async () => {
    state.caps = [];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "500",
    });

    expect(result).toEqual({ allowed: true, reservationId: "res_1" });
    expect(state.inserted).toHaveLength(1);
  });

  it("denies above the platform default when no cap row exists", async () => {
    // Without this the workflow path would stay the unbounded entrance to the
    // same wallet the direct-execution API caps.
    state.caps = [];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: (DEFAULT_WEI + BigInt(1)).toString(),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("applies the platform default when the daily value cap is null", async () => {
    state.caps = [{ dailyValueCapWei: null }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: ONE_ETH_WEI,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("allows and inserts a reserved row within the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.directSum = [{ totalWei: "600" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "300",
      source: "workflow",
      ref: "exec_1",
    });

    expect(result).toEqual({ allowed: true, reservationId: "res_1" });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      valueWei: "300",
      status: "reserved",
      source: "workflow",
      ref: "exec_1",
    });
  });

  it("denies (no insert) when the reservation would exceed the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.directSum = [{ totalWei: "600" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "500",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("denies with the halt reason when the org circuit breaker is engaged, regardless of cap or usage", async () => {
    state.orgHaltedAt = new Date();
    // Generous cap and zero usage: a cap check would allow this. The halt must
    // deny anyway, and before the cap row is even locked (no anchor created).
    state.caps = [{ dailyValueCapWei: "1000000000000000000000" }];
    state.directSum = [{ totalWei: "0" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "300",
    });

    expect(result).toEqual({ allowed: false, reason: ORG_HALTED_REASON });
    expect(state.inserted).toHaveLength(0);
    expect(state.capAnchors).toHaveLength(0);
  });

  it("creates the cap row so the FOR UPDATE lock has something to hold", async () => {
    // SELECT ... FOR UPDATE locks no rows when the row is absent, and "absent"
    // is every org this default newly covers. Without an anchor row, concurrent
    // callers would each read a zero total and each reserve the full default.
    state.caps = [];

    await reserveOrgValue({ organizationId: "org_1", valueWei: "500" });

    expect(state.capAnchors).toEqual([{ organizationId: "org_1" }]);
    // The anchor carries no cap figures: it must not freeze today's default
    // into the org's row.
    expect(state.caps).toEqual([
      { dailyValueCapWei: null, dailySolanaValueCapLamports: null },
    ]);
  });

  it("does not create a second cap row once one exists", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];

    await reserveOrgValue({ organizationId: "org_1", valueWei: "100" });

    expect(state.capAnchors).toHaveLength(0);
  });

  it("counts prior direct-execution spend in its own SUM", async () => {
    // 900 already spent via the direct API (directSum) leaves only 100 room;
    // a 200 workflow reservation is denied. Proves the ledger path sees direct
    // spend, the mirror of the direct path seeing ledger spend.
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.directSum = [{ totalWei: "900" }];

    const result = await reserveOrgValue({
      organizationId: "org_1",
      valueWei: "200",
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});

describe("withValueCap", () => {
  it("skips the cap and runs when the value is zero", async () => {
    const run = vi.fn().mockResolvedValue({ success: true, id: "ran" });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "0" },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, id: "ran" });
    expect(state.inserted).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("reserves then settles on a successful result", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "100" },
      run
    );

    expect(result).toEqual({ success: true });
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "settled" }),
    ]);
  });

  it("reserves then releases on a failed result", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    const run = vi.fn().mockResolvedValue({ success: false, error: "boom" });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "100" },
      run
    );

    expect(result).toEqual({ success: false, error: "boom" });
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "released" }),
    ]);
  });

  it("releases and rethrows when the run throws", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    const run = vi.fn().mockRejectedValue(new Error("kaboom"));

    await expect(
      withValueCap({ organizationId: "org_1", valueWei: "100" }, run)
    ).rejects.toThrow("kaboom");

    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "released" }),
    ]);
  });

  it("denies without running when over the cap", async () => {
    state.caps = [{ dailyValueCapWei: "100" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withValueCap(
      { organizationId: "org_1", valueWei: "500" },
      run
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Daily spending cap exceeded",
    });
    expect(state.updates).toHaveLength(0);
  });
});

describe("withStepValueCap", () => {
  it("runs without a cap check when the workflow has no organization", async () => {
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        stepFunction: "transferFundsStep",
        config: { amount: "1", network: "1" },
      },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true });
    expect(state.inserted).toHaveLength(0);
  });

  it("runs without a cap check when the step moves no native value", async () => {
    state.caps = [{ dailyValueCapWei: "1" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "writeContractStep",
        config: { ethValue: "0" },
      },
      run
    );
    await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "writeContractStep",
        config: {},
      },
      run
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(state.inserted).toHaveLength(0);
  });

  it("blocks the value-moving core when a workflow step exceeds the cap", async () => {
    state.caps = [{ dailyValueCapWei: ONE_ETH_WEI }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "transferFundsStep",
        config: { amount: "5", network: "1" },
        executionId: "exec_1",
      },
      run
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Daily spending cap exceeded",
    });
  });

  it("runs and settles a workflow step within the cap", async () => {
    state.caps = [{ dailyValueCapWei: ONE_ETH_WEI }];
    const run = vi.fn().mockResolvedValue({ success: true, hash: "0xabc" });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "transferFundsStep",
        config: { amount: "0.5", network: "1" },
        executionId: "exec_1",
      },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, hash: "0xabc" });
    expect(state.inserted[0]).toMatchObject({
      valueWei: "500000000000000000",
      source: "workflow",
      ref: "exec_1",
    });
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "settled" }),
    ]);
  });

  it("does not reserve when the caller already reserved (valueCapReserved)", async () => {
    state.caps = [{ dailyValueCapWei: ONE_ETH_WEI }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "transferFundsStep",
        config: { amount: "0.5", network: "1" },
        executionId: "exec_1",
        valueCapReserved: true,
      },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true });
    expect(state.inserted).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("charges Solana transferFundsStep against the lamports cap", async () => {
    state.reserveKind = "solana";
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "2000000000" },
    ];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "transferFundsStep",
        config: { amount: "1", network: "solana-devnet" },
        executionId: "exec_sol",
      },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true });
    expect(state.inserted[0]).toMatchObject({
      valueLamports: ONE_SOL_LAMPORTS,
      source: "workflow",
      ref: "exec_sol",
    });
  });

  it("charges transferSplTokenStep against the lamports cap using worst-case fee", async () => {
    state.reserveKind = "solana";
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "5000000" },
    ];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "transferSplTokenStep",
        config: { network: "103" },
        executionId: "exec_spl",
      },
      run
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true });
    expect(state.inserted[0]).toMatchObject({
      valueLamports: "2105000",
      source: "workflow",
      ref: "exec_spl",
    });
  });

  it("denies Solana sendRawSolanaInstructionStep when maxSol is missing", async () => {
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "sendRawSolanaInstructionStep",
        config: { network: "103" },
      },
      run
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("maxSol is required"),
    });
  });

  it("blocks Solana workflow step when lamports cap would be exceeded", async () => {
    state.reserveKind = "solana";
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "500000000" },
    ];
    state.directLamportsSum = [{ totalLamports: "400000000" }];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withStepValueCap(
      {
        organizationId: "org_1",
        stepFunction: "transferFundsStep",
        config: { amount: "0.2", network: "103" },
      },
      run
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Daily Solana spending cap exceeded",
    });
  });
});

describe("reserveOrgSolanaValue", () => {
  beforeEach(() => {
    state.reserveKind = "solana";
  });

  it("applies the platform default when no Solana cap row exists", async () => {
    state.caps = [];

    const under = await reserveOrgSolanaValue({
      organizationId: "org_1",
      valueLamports: "500",
    });
    expect(under).toEqual({ allowed: true, reservationId: "res_1" });

    const over = await reserveOrgSolanaValue({
      organizationId: "org_1",
      valueLamports: (DEFAULT_LAMPORTS + BigInt(1)).toString(),
    });
    expect(over).toEqual({
      allowed: false,
      reason: "Daily Solana spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(1);
  });

  it("allows and inserts a reserved lamports row within the cap", async () => {
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "2000000000" },
    ];

    const result = await reserveOrgSolanaValue({
      organizationId: "org_1",
      valueLamports: "1000000000",
      source: "workflow",
      ref: "exec_1",
    });

    expect(result).toEqual({ allowed: true, reservationId: "res_1" });
    expect(state.inserted[0]).toMatchObject({
      valueLamports: "1000000000",
      status: "reserved",
    });
  });

  it("denies when the lamports reservation would exceed the cap", async () => {
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "1000000000" },
    ];
    state.directLamportsSum = [{ totalLamports: "900000000" }];

    const result = await reserveOrgSolanaValue({
      organizationId: "org_1",
      valueLamports: "200000000",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily Solana spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("denies with the halt reason when the org circuit breaker is engaged, regardless of cap or usage", async () => {
    state.orgHaltedAt = new Date();
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "1000000000000" },
    ];
    state.directLamportsSum = [{ totalLamports: "0" }];

    const result = await reserveOrgSolanaValue({
      organizationId: "org_1",
      valueLamports: ONE_SOL_LAMPORTS,
    });

    expect(result).toEqual({ allowed: false, reason: ORG_HALTED_REASON });
    expect(state.inserted).toHaveLength(0);
    expect(state.capAnchors).toHaveLength(0);
  });
});

describe("withSolanaValueCap", () => {
  beforeEach(() => {
    state.reserveKind = "solana";
  });

  it("reserves then settles on a successful result", async () => {
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "2000000000" },
    ];
    const run = vi.fn().mockResolvedValue({ success: true });

    const result = await withSolanaValueCap(
      { organizationId: "org_1", valueLamports: "100000000" },
      run
    );

    expect(result).toEqual({ success: true });
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: "settled" }),
    ]);
  });
});
