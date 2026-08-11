import { beforeEach, describe, expect, it, vi } from "vitest";

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
  updated: [] as Record<string, unknown>[],
  paygCharge: { applicable: false } as
    | { applicable: false }
    | { applicable: true; ok: true; txHash: string }
    | { applicable: true; ok: false; reason: string; message: string },
}));

// Fake db.transaction whose tx supports what the reservation uses: the cap
// FOR UPDATE lookup (.for().limit()), the value SUM -- now two thenable
// .where() selects (direct executions, then the value ledger) via
// sumOrgValueTodayWei -- and the reservation insert.
vi.mock("@/lib/db", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => {
      let selectCall = 0;
      const tx = {
        select: () => {
          selectCall += 1;
          if (selectCall === 1) {
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
          // select #2 = direct-executions SUM, select #3 = ledger SUM.
          const rows = selectCall === 2 ? state.sumRows : state.ledgerRows;
          return {
            from: () => ({
              where: () => Promise.resolve(rows),
            }),
          };
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => {
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
  chargePaygIfBillable: () => Promise.resolve(state.paygCharge),
}));

import { checkAndReserveExecution } from "@/app/api/execute/_lib/spending-cap";

const baseParams = {
  organizationId: "org_1",
  apiKeyId: "key_1",
  type: "transfer",
  network: "1",
  input: { foo: "bar" },
};

beforeEach(() => {
  state.caps = [];
  state.sumRows = [{ totalWei: "0" }];
  state.ledgerRows = [{ totalWei: "0" }];
  state.inserted = [];
  state.updated = [];
  state.paygCharge = { applicable: false };
});

describe("checkAndReserveExecution value cap", () => {
  it("allows and records the reserved value when no cap row exists (unlimited)", async () => {
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

  it("treats a null dailyValueCapWei as unlimited", async () => {
    state.caps = [{ dailyValueCapWei: null }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "999" },
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

  it("treats an unset Solana cap as unlimited and does NOT fall back to the wei cap", async () => {
    // A wei cap that would reject this figure outright, to prove the Solana
    // path never consults it.
    state.caps = [{ dailyValueCapWei: "1", dailySolanaValueCapLamports: null }];
    state.sumRows = [{ totalLamports: "0" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "5000000000" },
    });

    expect(result.allowed).toBe(true);
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
});
