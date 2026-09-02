import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogSecurityEvent } = vi.hoisted(() => ({
  mockLogSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, logSecurityEvent: mockLogSecurityEvent };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/utils/id", () => ({ generateId: () => "exec_test" }));

// Hoisted state the fake tx reads from / writes to, set per test.
const state = vi.hoisted(() => ({
  caps: [] as Array<{
    dailyValueCapWei: string | null;
    dailySolanaValueCapLamports?: string | null;
  }>,
  sumRows: [] as Array<{ totalWei?: string; totalLamports?: string }>,
  ledgerRows: [] as Array<{ totalWei?: string; totalLamports?: string }>,
  inserted: [] as Record<string, unknown>[],
  capAnchors: [] as Record<string, unknown>[],
  capInsertLosesRace: false,
  updated: [] as Record<string, unknown>[],
  paygCharge: { applicable: false } as
    | { applicable: false }
    | { applicable: true; ok: true; txHash: string }
    | { applicable: true; ok: false; reason: string; message: string },
  paygChargeCalls: [] as Record<string, unknown>[],
}));

// A cap-row insert carries nothing but the org id: lockOrgSpendCapRow creates
// the row purely as a lock anchor, with both cap columns left NULL.
function isCapAnchorInsert(values: Record<string, unknown>): boolean {
  return Object.keys(values).length === 1 && "organizationId" in values;
}

// Fake db.transaction whose tx supports what the reservation uses: the cap
// FOR UPDATE lookup (.for().limit()), recognised by the columns it selects
// because lockOrgSpendCapRow may run it twice; the anchor insert when the org
// has no row; the value SUM -- two thenable .where() selects (direct
// executions, then the value ledger) via sumOrgValueTodayWei -- and the
// reservation insert.
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
          sumCall += 1;
          const rows = sumCall === 1 ? state.sumRows : state.ledgerRows;
          return {
            from: () => ({
              where: () => Promise.resolve(rows),
            }),
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
            return Promise.resolve(undefined);
          },
        }),
      };
      return cb(tx);
    },
    // The reserved row is marked failed here when a PAYG charge is blocked.
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updated.push(v);
          return Promise.resolve(undefined);
        },
      }),
    }),
  },
}));

// PAYG charge runs after a successful reservation. Value-cap tests keep it a
// no-op (applicable: false); the PAYG-charge tests drive it via state.paygCharge.
vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: (params: Record<string, unknown>) => {
    state.paygChargeCalls.push(params);
    return Promise.resolve(state.paygCharge);
  },
}));

import { checkAndReserveExecution } from "@/app/api/execute/_lib/spending-cap";
import {
  getDefaultDailySolanaValueCapLamports,
  getDefaultDailyValueCapWei,
} from "@/lib/execute/spend-cap-defaults";

const DEFAULT_WEI = BigInt(getDefaultDailyValueCapWei());
const DEFAULT_LAMPORTS = BigInt(getDefaultDailySolanaValueCapLamports());

const baseParams = {
  organizationId: "org_1",
  apiKeyId: "key_1",
  type: "transfer",
  network: "1",
  input: { foo: "bar" },
  // The admission verdict the route reached before anything was written.
  paygOverflow: false,
};

beforeEach(() => {
  mockLogSecurityEvent.mockClear();
  state.caps = [];
  state.sumRows = [{ totalWei: "0" }];
  state.ledgerRows = [{ totalWei: "0" }];
  state.inserted = [];
  state.capAnchors = [];
  state.capInsertLosesRace = false;
  state.updated = [];
  state.paygCharge = { applicable: false };
  state.paygChargeCalls = [];
});

describe("platform default cap figures", () => {
  // Pinned so a change to the policy is a deliberate test edit rather than a
  // silent widening. Every other test derives its expectations from these
  // getters, so without this nothing would catch an added zero.
  it("is 0.02 ETH per day for EVM chains", () => {
    expect(getDefaultDailyValueCapWei()).toBe("20000000000000000");
  });

  it("is 0.5 SOL per day for Solana", () => {
    expect(getDefaultDailySolanaValueCapLamports()).toBe("500000000");
  });
});

describe("checkAndReserveExecution value cap", () => {
  it("allows a value under the platform default when no cap row exists", async () => {
    state.caps = [];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "5" },
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      valueWei: "5",
      status: "pending",
    });
  });

  it("denies above the platform default when no cap row exists", async () => {
    // The historical fail-open: every org started without a cap row, so a
    // leaked key was bounded only by the wallet balance.
    state.caps = [];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: (DEFAULT_WEI + BigInt(1)).toString() },
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("creates the cap row so the FOR UPDATE lock has something to hold", async () => {
    state.caps = [];

    await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "5" },
    });

    expect(state.capAnchors).toEqual([{ organizationId: "org_1" }]);
    // The anchor carries no cap figures, so the org keeps tracking the platform
    // default rather than freezing today's value into its row.
    expect(state.caps).toEqual([
      { dailyValueCapWei: null, dailySolanaValueCapLamports: null },
    ]);
  });

  it("applies the platform default when dailyValueCapWei is null", async () => {
    state.caps = [{ dailyValueCapWei: null }];

    const under = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "999" },
    });
    expect(under.allowed).toBe(true);
    expect(state.inserted).toHaveLength(1);

    const over = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: (DEFAULT_WEI + BigInt(1)).toString() },
    });
    expect(over.allowed).toBe(false);
    expect(state.inserted).toHaveLength(1);
  });

  it("lets an explicit cap raise the ceiling above the platform default", async () => {
    const raised = (DEFAULT_WEI * BigInt(100)).toString();
    state.caps = [{ dailyValueCapWei: raised }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: {
        kind: "evm",
        valueWei: (DEFAULT_WEI * BigInt(10)).toString(),
      },
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted).toHaveLength(1);
  });

  it("allows when the day's total plus this reservation stays within the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "400" },
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted[0]).toMatchObject({ valueWei: "400" });
  });

  it("denies when the reservation would push the day's total over the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "500" },
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("counts workflow/protocol value (the ledger) against a direct reservation", async () => {
    // Direct spend 600 + ledger (workflow) spend 300 = 900; a further 200
    // direct reservation would reach 1100 > 1000 -> denied. Without the ledger
    // in the SUM this would wrongly pass (600 + 200 = 800).
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];
    state.ledgerRows = [{ totalWei: "300" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "200" },
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });

  it("blocks a single wallet-draining reservation even with a zero recorded total (TOCTOU closed)", async () => {
    // The reservation alone (5 ETH) exceeds a 1 ETH cap although the recorded
    // day total is still 0 -- value is known up front, unlike gas.
    state.caps = [{ dailyValueCapWei: "1000000000000000000" }];
    state.sumRows = [{ totalWei: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "5000000000000000000" },
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});

describe("checkAndReserveExecution zero-value requests", () => {
  // `total + reserved > dailyCap` collapses to `total > dailyCap` at reserved
  // = 0, so once an org went over for the day every later zero-value request
  // was refused too -- node executions and reads that cannot move anything.
  // Only reachable since an absent cap stopped meaning unlimited: before that
  // an unconfigured org returned before the comparison ran.
  it("admits a zero-value request when the day is already over the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000000000000000000" }];
    state.sumRows = [{ totalWei: "5000000000000000000" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted).toHaveLength(1);
  });

  it("admits a zero-lamport request when the Solana day is over the cap", async () => {
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "1000000000" },
    ];
    state.sumRows = [{ totalLamports: "5000000000" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "solana", valueLamports: "0" },
    });

    expect(result.allowed).toBe(true);
  });

  // The row exists only as a lock anchor. A request that moves nothing cannot
  // race anyone for budget, so it should not pay for the insert or hold the
  // lock -- and zero-value traffic is the bulk of it.
  it("takes no cap-row lock for a zero-value request", async () => {
    state.caps = [];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result.allowed).toBe(true);
    expect(state.capAnchors).toHaveLength(0);
  });

  // Guards the boundary: one wei is not zero and must still be charged.
  it("still charges a one-wei reservation against the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000000000000000000" }];
    state.sumRows = [{ totalWei: "1000000000000000000" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "1" },
    });

    expect(result.allowed).toBe(false);
  });
});

describe("spend_cap_default_applied attribution", () => {
  function reasonOf(): string | undefined {
    const call = mockLogSecurityEvent.mock.calls.find(
      ([name]) => name === "spend_cap_default_applied"
    );
    return (call?.[1] as { reason?: string } | undefined)?.reason;
  }

  it("reports no_cap_row when this transaction created the row", async () => {
    state.caps = [];
    state.sumRows = [{ totalWei: "0" }];

    await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "1" },
    });

    expect(reasonOf()).toBe("no_cap_row");
  });

  // lockOrgSpendCapRow used to report created: true whenever it reached the
  // insert, even when onConflictDoNothing did nothing because a concurrent
  // transaction got there first. That attributed the race to "this org has
  // never configured a cap", which is a different and more alarming claim than
  // "two requests arrived together".
  it("does not report no_cap_row when a concurrent transaction created it", async () => {
    state.caps = [];
    state.sumRows = [{ totalWei: "0" }];
    state.capInsertLosesRace = true;

    await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "1" },
    });

    expect(reasonOf()).toBe("cap_unset_for_chain_family");
  });
});

describe("checkAndReserveExecution Solana cap", () => {
  it("charges the lamports cap and records valueLamports, not valueWei", async () => {
    state.caps = [
      { dailyValueCapWei: "1000", dailySolanaValueCapLamports: "2000000000" },
    ];
    state.sumRows = [{ totalLamports: "500000000" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "1000000000" },
    });

    expect(result.allowed).toBe(true);
    // The unit columns are mutually exclusive, so each daily SUM stays
    // single-unit.
    expect(state.inserted[0]).toMatchObject({
      valueLamports: "1000000000",
      valueWei: null,
    });
  });

  it("denies with the Solana-specific reason when the lamports cap is exceeded", async () => {
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "1000000000" },
    ];
    state.sumRows = [{ totalLamports: "900000000" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "200000000" },
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily Solana spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("falls back to the Solana default when unset, never to the wei cap", async () => {
    // A wei cap that would reject either figure outright, to prove the Solana
    // path never consults it: the small reservation is allowed and the large
    // one is denied purely by the Solana default.
    state.caps = [{ dailyValueCapWei: "1", dailySolanaValueCapLamports: null }];
    state.sumRows = [{ totalLamports: "0" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const under = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "5000" },
    });
    expect(under.allowed).toBe(true);

    const over = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: {
        kind: "solana",
        valueLamports: (DEFAULT_LAMPORTS + BigInt(1)).toString(),
      },
    });
    expect(over).toEqual({
      allowed: false,
      reason: "Daily Solana spending cap exceeded",
    });
  });

  it("does not let an exhausted wei cap block a Solana reservation", async () => {
    state.caps = [
      { dailyValueCapWei: "1000", dailySolanaValueCapLamports: "2000000000" },
    ];
    // Solana totals are read from the lamports columns; the wei day-total is
    // irrelevant to this reservation and must not be consulted.
    state.sumRows = [{ totalWei: "999999", totalLamports: "0" }];
    state.ledgerRows = [{ totalWei: "999999", totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "1000000000" },
    });

    expect(result.allowed).toBe(true);
  });
});

describe("checkAndReserveExecution PAYG charge", () => {
  it("keeps the reservation when a billable execution charges successfully", async () => {
    state.paygCharge = { applicable: true, ok: true, txHash: "0xabc" };

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
      paygOverflow: true,
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.inserted).toHaveLength(1);
    expect(state.updated).toHaveLength(0);
  });

  it("denies and marks the reserved row failed when the PAYG charge is blocked", async () => {
    const message =
      "Daily pay-as-you-go spend limit reached. Raise your daily limit or wait until tomorrow.";
    state.paygCharge = {
      applicable: true,
      ok: false,
      reason: "daily_cap",
      message,
    };

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
      paygOverflow: true,
    });

    expect(result).toEqual({ allowed: false, reason: message });
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]).toMatchObject({
      status: "failed",
      error: message,
    });
  });

  it("passes non-PAYG orgs through without charging or denying", async () => {
    state.paygCharge = { applicable: false };

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.updated).toHaveLength(0);
  });

  // The reservation is committed before the charge, so the charge point can no
  // longer tell an over-limit run from the last included one. It gets the
  // verdict the route already reached instead.
  it("hands the charge point the admission verdict rather than letting it recount", async () => {
    await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
      paygOverflow: false,
    });
    await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
      paygOverflow: true,
    });

    expect(state.paygChargeCalls.map((c) => c.paygOverflow)).toEqual([
      false,
      true,
    ]);
  });
});
