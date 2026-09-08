import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetExecutionCountCacheForTest } from "../lib/billing/execution-limit-core";
import { PAYG_OVERFLOW_REASON } from "../lib/billing/payg/constants";
import { executionDebt, organizationSubscriptions } from "../lib/db/schema";
import { checkExecutionLimitForExecutor } from "./billing-guard";

type SubRow = { plan: string; tier: string | null; status: string };

// The guard awaits `.where(...)` directly for debt and `.where(...).limit(1)`
// for the subscription, so the fake resolves both shapes from one object.
function resultFor(rows: unknown[]): Promise<unknown[]> & {
  limit: () => Promise<unknown[]>;
} {
  const result = Promise.resolve(rows) as Promise<unknown[]> & {
    limit: () => Promise<unknown[]>;
  };
  result.limit = () => Promise.resolve(rows);
  return result;
}

function fakeDb(params: { sub: SubRow | null; used: number; debt: number }) {
  const execute = vi.fn().mockResolvedValue([{ count: params.used }]);
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === organizationSubscriptions) {
          return resultFor(params.sub ? [params.sub] : []);
        }
        if (table === executionDebt) {
          return resultFor(
            params.debt > 0 ? [{ debt: params.debt }] : []
          );
        }
        return resultFor([]);
      },
    }),
  }));
  return { select, execute };
}

function asDb(
  db: ReturnType<typeof fakeDb>
): Parameters<typeof checkExecutionLimitForExecutor>[0] {
  return db as unknown as Parameters<typeof checkExecutionLimitForExecutor>[0];
}

const FREE_LIMIT = 5000;

beforeEach(() => {
  __resetExecutionCountCacheForTest();
  vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
});

describe("checkExecutionLimitForExecutor pay-as-you-go admission", () => {
  it("admits a free org past its limit that never set spend caps", async () => {
    const db = fakeDb({
      sub: { plan: "free", tier: null, status: "active" },
      used: FREE_LIMIT,
      debt: 0,
    });

    const result = await checkExecutionLimitForExecutor(asDb(db), "org_1");

    expect(result).toEqual({ allowed: true, reason: PAYG_OVERFLOW_REASON });
  });

  it("admits a free org with no subscription row at all", async () => {
    const db = fakeDb({ sub: null, used: FREE_LIMIT + 120, debt: 0 });

    const result = await checkExecutionLimitForExecutor(asDb(db), "org_2");

    expect(result).toEqual({ allowed: true, reason: PAYG_OVERFLOW_REASON });
  });

  it("keeps a free org under its limit on the normal path", async () => {
    const db = fakeDb({
      sub: { plan: "free", tier: null, status: "active" },
      used: FREE_LIMIT - 1,
      debt: 0,
    });

    const result = await checkExecutionLimitForExecutor(asDb(db), "org_3");

    expect(result).toEqual({ allowed: true, reason: "within_limit" });
  });

  it("still blocks a paid org carrying unpaid overage debt", async () => {
    const db = fakeDb({
      sub: { plan: "pro", tier: "25k", status: "active" },
      used: 10,
      debt: 100,
    });

    const result = await checkExecutionLimitForExecutor(asDb(db), "org_4");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("active_debt");
    }
  });

  // Free carries no overage, so debt cannot block there. Matches
  // checkExecutionLimit, which reaches the same outcome on the web path.
  it("admits a free org past its limit even with debt on the row", async () => {
    const db = fakeDb({
      sub: { plan: "free", tier: null, status: "active" },
      used: FREE_LIMIT,
      debt: 100,
    });

    const result = await checkExecutionLimitForExecutor(asDb(db), "org_5");

    expect(result).toEqual({ allowed: true, reason: PAYG_OVERFLOW_REASON });
  });

  it("does not query the pay-as-you-go config to decide admission", async () => {
    const db = fakeDb({
      sub: { plan: "free", tier: null, status: "active" },
      used: FREE_LIMIT,
      debt: 0,
    });

    await checkExecutionLimitForExecutor(asDb(db), "org_5");

    // Subscription plus debt only. A third select is the config lookup coming back.
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
