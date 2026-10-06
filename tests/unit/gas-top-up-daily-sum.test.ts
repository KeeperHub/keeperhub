import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const { mockLogSecurityEvent } = vi.hoisted(() => ({
  mockLogSecurityEvent: vi.fn(),
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSecurityEvent: mockLogSecurityEvent,
}));

import {
  gasTopUpDailyLimit,
  type StablecoinDailyLimit,
  stablecoinDailyLimitDenial,
  sumOrgGasTopUpTodayMicroUsd,
} from "@/lib/execute/value-ledger";

// Answers the sum query with `rows`. Which rows the predicate takes is proven
// against Postgres in tests/db/gas-top-up-daily-sum.db.test.ts.
function fakeExecutor(rows: Array<{ totalMicroUsd: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

describe("sumOrgGasTopUpTodayMicroUsd", () => {
  it("returns the day's total as a bigint", async () => {
    const executor = fakeExecutor([{ totalMicroUsd: "150000000" }]);

    await expect(sumOrgGasTopUpTodayMicroUsd(executor, "org_1")).resolves.toBe(
      BigInt(150_000_000)
    );
  });

  it("treats an empty result as zero", async () => {
    const executor = fakeExecutor([]);

    await expect(sumOrgGasTopUpTodayMicroUsd(executor, "org_1")).resolves.toBe(
      BigInt(0)
    );
  });
});

describe("stablecoinDailyLimitDenial", () => {
  afterEach(() => {
    mockLogSecurityEvent.mockClear();
  });

  function limit(usedMicroUsd: bigint, amountMicroUsd: bigint) {
    const sumTodayMicroUsd = vi.fn().mockResolvedValue(usedMicroUsd);
    const daily: StablecoinDailyLimit = {
      amountMicroUsd,
      capMicroUsd: BigInt(200_000_000),
      sumTodayMicroUsd,
      label: "gas top-up",
    };
    return { daily, sumTodayMicroUsd };
  }

  it.each([
    ["under", BigInt(100_000_000)],
    ["exactly at", BigInt(195_000_000)],
  ])("allows a request that ends %s the cap", async (_label, used) => {
    const { daily, sumTodayMicroUsd } = limit(used, BigInt(5_000_000));
    const executor = { tag: "tx" };

    await expect(
      stablecoinDailyLimitDenial(executor, "org_1", daily)
    ).resolves.toBeNull();
    expect(sumTodayMicroUsd).toHaveBeenCalledWith(executor, "org_1");
    expect(mockLogSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a request that would pass the cap, with the amounts, and logs it", async () => {
    const { daily } = limit(BigInt(198_000_000), BigInt(5_000_000));

    await expect(stablecoinDailyLimitDenial({}, "org_1", daily)).resolves.toBe(
      "Daily gas top-up limit exceeded: 198 USD used today, 5 USD requested, limit 200 USD"
    );
    expect(mockLogSecurityEvent).toHaveBeenCalledWith(
      "stablecoin_daily_cap_blocked",
      {
        organizationId: "org_1",
        surface: "gas top-up",
        usedMicroUsd: "198000000",
        requestedMicroUsd: "5000000",
        capMicroUsd: "200000000",
      }
    );
  });
});

describe("gasTopUpDailyLimit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("charges the gas top-up sum against the 200 USD default", () => {
    vi.stubEnv("EXECUTE_DEFAULT_DAILY_GAS_TOP_UP_CAP_MICRO_USD", "");

    expect(gasTopUpDailyLimit(BigInt(5_000_000))).toEqual({
      amountMicroUsd: BigInt(5_000_000),
      capMicroUsd: BigInt(200_000_000),
      sumTodayMicroUsd: sumOrgGasTopUpTodayMicroUsd,
      label: "gas top-up",
    });
  });

  it("follows the deployment's cap override", () => {
    vi.stubEnv("EXECUTE_DEFAULT_DAILY_GAS_TOP_UP_CAP_MICRO_USD", "50000000");

    expect(gasTopUpDailyLimit(BigInt(1)).capMicroUsd).toBe(BigInt(50_000_000));
  });
});
