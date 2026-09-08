import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// PAYG settlement runs after a successful reservation; make it a no-op so the
// zero-value (read) case does not touch billing.
vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: () => Promise.resolve({ applicable: false }),
}));

const state = vi.hoisted(() => ({
  orgHaltedAt: null as Date | null,
  inserted: [] as Record<string, unknown>[],
}));

// Fake db: the halted read is a select whose columns include "haltedAt"; the
// direct-execution reservation is an insert whose values() is awaited directly.
vi.mock("@/lib/db", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => {
      const tx = {
        select: (fields: Record<string, unknown>) => {
          const columns = Object.keys(fields ?? {});
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
          throw new Error(`unexpected select columns: ${columns.join(",")}`);
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
  },
}));

import { checkAndReserveExecution } from "@/app/api/execute/_lib/spending-cap";
import { ORG_HALTED_REASON } from "@/lib/execute/org-circuit-breaker";

const BASE = {
  organizationId: "org_1",
  apiKeyId: "kh_test",
  type: "transfer",
  input: {},
  paygOverflow: false,
} as const;

beforeEach(() => {
  state.orgHaltedAt = null;
  state.inserted = [];
});

describe("checkAndReserveExecution circuit breaker", () => {
  it("fails a value-moving direct execution closed while the org is halted, with no reservation", async () => {
    state.orgHaltedAt = new Date();

    const result = await checkAndReserveExecution({
      ...BASE,
      reserved: { kind: "evm", valueWei: "100" },
    });

    expect(result).toEqual({ allowed: false, reason: ORG_HALTED_REASON });
    expect(state.inserted).toHaveLength(0);
  });

  it("fails a value-moving Solana direct execution closed while the org is halted", async () => {
    state.orgHaltedAt = new Date();

    const result = await checkAndReserveExecution({
      ...BASE,
      reserved: { kind: "solana", valueLamports: "100" },
    });

    expect(result).toEqual({ allowed: false, reason: ORG_HALTED_REASON });
    expect(state.inserted).toHaveLength(0);
  });

  it("lets a zero-value (read) direct execution through even while halted", async () => {
    state.orgHaltedAt = new Date();

    const result = await checkAndReserveExecution({
      ...BASE,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result).toMatchObject({ allowed: true });
    expect(state.inserted).toHaveLength(1);
  });
});
