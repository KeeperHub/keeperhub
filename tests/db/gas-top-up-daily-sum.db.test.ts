/**
 * The gas top-up daily sum against a real Postgres.
 *
 * The unit suite renders the query through a fake executor that never runs it,
 * so it cannot show which rows the predicate takes. This file seeds rows on
 * both sides of every edge the sum depends on: the in-flight statuses, the
 * swap flags a finished run carries, UTC midnight, the organization and the
 * execution type.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { directExecutions, organization } from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_gas_top_up_sum_";
const ORG = `${PREFIX}org`;
const ORG_OTHER = `${PREFIX}org_other`;

const NOW = new Date(Date.UTC(2026, 2, 10, 15));
const MIDNIGHT = new Date(Date.UTC(2026, 2, 10));
const BEFORE_MIDNIGHT = new Date(MIDNIGHT.getTime() - 1);
const TWELVE_HOURS_AGO = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);
const YESTERDAY = new Date(Date.UTC(2026, 2, 9, 15));

type TopUpRow = {
  status: string;
  output?: Record<string, unknown>;
  createdAt?: Date;
  org?: string;
  type?: string;
};

type Case = TopUpRow & { label: string; counted: boolean };

const CASES: Case[] = [
  { label: "a pending run", status: "pending", counted: true },
  {
    label: "a running run created exactly at UTC midnight",
    status: "running",
    createdAt: MIDNIGHT,
    counted: true,
  },
  {
    label: "a running run twelve hours old",
    status: "running",
    createdAt: TWELVE_HOURS_AGO,
    counted: true,
  },
  {
    label: "a failed run whose swap landed",
    status: "failed",
    output: { swapLanded: true },
    counted: true,
  },
  {
    label: "a completed run whose swap landed",
    status: "completed",
    output: { swapLanded: true },
    counted: true,
  },
  {
    label: "a completed run whose swap is pending",
    status: "completed",
    output: { swapPending: true },
    counted: true,
  },
  {
    label: "an unconfirmed run whose swap is pending",
    status: "unconfirmed",
    output: { swapPending: true },
    counted: true,
  },
  {
    label: "a completed run that only approved",
    status: "completed",
    output: { swapLanded: false },
    counted: false,
  },
  {
    label: "an unconfirmed run with no pending swap",
    status: "unconfirmed",
    output: {},
    counted: false,
  },
  {
    label: "a failed run that never swapped",
    status: "failed",
    output: { swapLanded: false, approvalRevoked: true },
    counted: false,
  },
  {
    label: "a pending swap the reconciler marked failed",
    status: "failed",
    output: { swapPending: true },
    counted: false,
  },
  {
    label: "a pending run created 1 ms before UTC midnight",
    status: "pending",
    createdAt: BEFORE_MIDNIGHT,
    counted: false,
  },
  {
    label: "yesterday's landed swap",
    status: "completed",
    output: { swapLanded: true },
    createdAt: YESTERDAY,
    counted: false,
  },
  {
    label: "another organization's pending run",
    status: "pending",
    org: ORG_OTHER,
    counted: false,
  },
  {
    label: "a pending execution of another type",
    status: "pending",
    type: "protocol-action",
    counted: false,
  },
];

let seq = 0;

async function addTopUp(row: TopUpRow, amountMicroUsd: bigint): Promise<void> {
  seq += 1;
  await testDb.insert(directExecutions).values({
    id: `${PREFIX}${seq}`,
    organizationId: row.org ?? ORG,
    apiKeyId: `${PREFIX}key`,
    type: row.type ?? "gas-top-up",
    status: row.status,
    input: { amountMicroUsd: amountMicroUsd.toString() },
    output: row.output ?? null,
    createdAt: row.createdAt ?? NOW,
  });
}

async function cleanup(): Promise<void> {
  for (const org of [ORG, ORG_OTHER]) {
    await testDb
      .delete(directExecutions)
      .where(eq(directExecutions.organizationId, org));
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const org of [ORG, ORG_OTHER]) {
    await testDb
      .insert(organization)
      .values({ id: org, name: "t", slug: org, createdAt: NOW })
      .onConflictDoNothing();
  }
});

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  for (const org of [ORG, ORG_OTHER]) {
    await testDb.delete(organization).where(eq(organization.id, org));
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await queryClient.end();
});

describe("sumOrgGasTopUpTodayMicroUsd (real database)", () => {
  it.each(CASES)(
    "$label: counted $counted",
    async ({ label: _label, counted, ...row }) => {
      const { sumOrgGasTopUpTodayMicroUsd } = await import(
        "../../lib/execute/value-ledger"
      );
      const amount = BigInt(5_000_000);
      await addTopUp(row, amount);

      await expect(sumOrgGasTopUpTodayMicroUsd(testDb, ORG)).resolves.toBe(
        counted ? amount : BigInt(0)
      );
    }
  );

  it("sums exactly the counted rows when every case is present", async () => {
    const { sumOrgGasTopUpTodayMicroUsd } = await import(
      "../../lib/execute/value-ledger"
    );
    let expected = BigInt(0);
    for (const [index, { label: _label, counted, ...row }] of CASES.entries()) {
      // A distinct bit per row, so a wrong total names the rows behind it.
      const amount = BigInt(2) ** BigInt(index);
      await addTopUp(row, amount);
      if (counted) {
        expected += amount;
      }
    }

    await expect(sumOrgGasTopUpTodayMicroUsd(testDb, ORG)).resolves.toBe(
      expected
    );
  });
});

describe("stablecoinDailyLimitDenial (real database)", () => {
  it("charges only the counted rows against the gas top-up cap", async () => {
    vi.stubEnv("EXECUTE_DEFAULT_DAILY_GAS_TOP_UP_CAP_MICRO_USD", "200000000");
    const { gasTopUpDailyLimit, stablecoinDailyLimitDenial } = await import(
      "../../lib/execute/value-ledger"
    );
    await addTopUp({ status: "running" }, BigInt(150_000_000));
    await addTopUp(
      { status: "completed", output: { swapLanded: true } },
      BigInt(48_000_000)
    );
    // Uncounted rows worth far more than the cap.
    await addTopUp(
      { status: "completed", output: { swapLanded: false } },
      BigInt(500_000_000)
    );
    await addTopUp(
      { status: "pending", createdAt: BEFORE_MIDNIGHT },
      BigInt(500_000_000)
    );

    await expect(
      stablecoinDailyLimitDenial(
        testDb,
        ORG,
        gasTopUpDailyLimit(BigInt(1_000_000))
      )
    ).resolves.toBeNull();
    await expect(
      stablecoinDailyLimitDenial(
        testDb,
        ORG,
        gasTopUpDailyLimit(BigInt(5_000_000))
      )
    ).resolves.toBe(
      "Daily gas top-up limit exceeded: 198 USD used today, 5 USD requested, limit 200 USD"
    );
  });
});
