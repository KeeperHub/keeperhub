import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetExecutionCountCacheForTest,
  countMonthlyExecutionsForAdmission,
  decideExecutionLimit,
  statusAllowsOverage,
} from "@/lib/billing/execution-limit-core";

type FakeDb = { execute: ReturnType<typeof vi.fn> };

function fakeDb(): FakeDb {
  return { execute: vi.fn() };
}

// The reader only touches db.execute; the cast keeps the fake minimal.
function asDb(
  db: FakeDb
): Parameters<typeof countMonthlyExecutionsForAdmission>[0] {
  return db as unknown as Parameters<
    typeof countMonthlyExecutionsForAdmission
  >[0];
}

// A plan the org is nowhere near, so admission always takes the cached path.
const FAR_FROM_LIMIT = {
  maxExecutionsPerMonth: 1_000_000,
  overageEnabled: false,
};

const SINCE = new Date("2026-07-01T00:00:00.000Z");

beforeEach(() => {
  __resetExecutionCountCacheForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("execution count cache", () => {
  it("shares a single in-flight query across concurrent callers", async () => {
    const db = fakeDb();
    let resolveQuery: (rows: { count: number }[]) => void = () => {
      /* replaced below */
    };
    db.execute.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      })
    );

    const first = countMonthlyExecutionsForAdmission(
      asDb(db),
      "org_1",
      FAR_FROM_LIMIT,
      SINCE
    );
    const second = countMonthlyExecutionsForAdmission(
      asDb(db),
      "org_1",
      FAR_FROM_LIMIT,
      SINCE
    );
    resolveQuery([{ count: 7 }]);

    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("serves the cached count within the TTL", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 3 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(3);
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.stubEnv("BILLING_COUNT_CACHE_TTL_MS", "1");
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([{ count: 4 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(4);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per organization", async () => {
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 2 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(1);
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_2",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(2);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per window start so a month rollover refetches", async () => {
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 500 }])
      .mockResolvedValueOnce([{ count: 0 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(500);
    const nextMonth = new Date("2026-08-01T00:00:00.000Z");
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        nextMonth
      )
    ).toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed refresh so the next caller retries", async () => {
    const db = fakeDb();
    db.execute
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce([{ count: 9 }]);

    await expect(
      countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).rejects.toThrow("statement timeout");
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(9);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("recomputes on every call when the TTL is 0", async () => {
    vi.stubEnv("BILLING_COUNT_CACHE_TTL_MS", "0");
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 2 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(1);
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(2);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default TTL on a malformed env value", async () => {
    vi.stubEnv("BILLING_COUNT_CACHE_TTL_MS", "30s");
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 3 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(3);
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

describe("countMonthlyExecutionsForAdmission", () => {
  const FREE = { maxExecutionsPerMonth: 5000, overageEnabled: false };
  const PAID = { maxExecutionsPerMonth: 25_000, overageEnabled: true };

  it("refuses a burst the stale count would have admitted", async () => {
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 4999 }])
      .mockResolvedValue([{ count: 5000 }]);

    expect(
      await countMonthlyExecutionsForAdmission(asDb(db), "org_1", FREE, SINCE)
    ).toBe(4999);
    // Second admission inside the same TTL window must not reuse 4999.
    expect(
      await countMonthlyExecutionsForAdmission(asDb(db), "org_1", FREE, SINCE)
    ).toBe(5000);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("does not re-read a count it just fetched itself", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 5000 }]);

    expect(
      await countMonthlyExecutionsForAdmission(asDb(db), "org_1", FREE, SINCE)
    ).toBe(5000);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the cache for an org far below its limit", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 100 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(100);
    expect(
      await countMonthlyExecutionsForAdmission(asDb(db), "org_1", FREE, SINCE)
    ).toBe(100);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the cache for plans that bill overage", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 25_000 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(25_000);
    expect(
      await countMonthlyExecutionsForAdmission(asDb(db), "org_1", PAID, SINCE)
    ).toBe(25_000);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("returns to the cache once an org is well past its limit", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 20_000 }]);

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(20_000);
    expect(
      await countMonthlyExecutionsForAdmission(asDb(db), "org_1", FREE, SINCE)
    ).toBe(20_000);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the cache for unlimited plans", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 400_000 }]);
    const unlimited = { maxExecutionsPerMonth: -1, overageEnabled: false };

    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        FAR_FROM_LIMIT,
        SINCE
      )
    ).toBe(400_000);
    expect(
      await countMonthlyExecutionsForAdmission(
        asDb(db),
        "org_1",
        unlimited,
        SINCE
      )
    ).toBe(400_000);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

describe("statusAllowsOverage", () => {
  it("allows an active subscription past the included limit", () => {
    expect(statusAllowsOverage("active")).toBe(true);
  });

  it("allows a trial past the included limit so the excess is billed", () => {
    expect(statusAllowsOverage("trialing")).toBe(true);
  });

  it.each(["past_due", "canceled", "incomplete", "unpaid", null, undefined])(
    "stops %s at the included limit",
    (status) => {
      expect(statusAllowsOverage(status)).toBe(false);
    }
  );
});

describe("decideExecutionLimit", () => {
  const AT_LIMIT = {
    maxExecutionsPerMonth: 25_000,
    used: 25_000,
    debtExecutions: 0,
    overageEnabled: true,
  };

  it("bills a trial for the excess rather than blocking it", () => {
    expect(
      decideExecutionLimit({
        ...AT_LIMIT,
        statusAllowsOverage: statusAllowsOverage("trialing"),
      })
    ).toBe("overage");
  });

  it("leaves a trial under its included quota alone", () => {
    expect(
      decideExecutionLimit({
        ...AT_LIMIT,
        used: 24_999,
        statusAllowsOverage: statusAllowsOverage("trialing"),
      })
    ).toBe("within_limit");
  });

  it("bills an active subscription for the excess", () => {
    expect(
      decideExecutionLimit({
        ...AT_LIMIT,
        statusAllowsOverage: statusAllowsOverage("active"),
      })
    ).toBe("overage");
  });

  it("blocks a past_due subscription at the limit", () => {
    expect(
      decideExecutionLimit({
        ...AT_LIMIT,
        statusAllowsOverage: statusAllowsOverage("past_due"),
      })
    ).toBe("blocked_limit");
  });

  it("blocks a plan without overage at the limit", () => {
    expect(
      decideExecutionLimit({
        ...AT_LIMIT,
        overageEnabled: false,
        statusAllowsOverage: statusAllowsOverage("active"),
      })
    ).toBe("blocked_limit");
  });

  it("blocks on outstanding debt before considering the count", () => {
    expect(
      decideExecutionLimit({
        ...AT_LIMIT,
        used: 0,
        debtExecutions: 500,
        statusAllowsOverage: statusAllowsOverage("trialing"),
      })
    ).toBe("blocked_debt");
  });
});
