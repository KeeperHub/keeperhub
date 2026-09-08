import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization } from "../../../lib/db/schema";
import {
  directExecutions,
  orgValueReservations,
} from "../../../lib/db/schema-extensions";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; getSpendCapData must hit Postgres,
// because the behaviour under test is exactly which rows the daily-usage SUM
// counts - its WHERE clause (org, UTC-day and status scoping), not the shape of
// the generated SQL.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_spend_cap_daily_";
const ORG_FRESH = `${PREFIX}fresh`;
const ORG_ATCAP = `${PREFIX}atcap`;
const ORG_SCOPE = `${PREFIX}scope`;
const ORG_OTHER = `${PREFIX}other`;

// wei figures, chosen so the SUM total is unambiguous.
const SETTLED_TODAY_WEI = "20000000000000000"; // 0.02 ETH, counts
const RESERVED_FRESH_WEI = "1000000000000000"; // 0.001 ETH, in-flight <15m, counts
const DIRECT_COMPLETED_WEI = "3000000000000000"; // 0.003 ETH, counts (other store)
const RESERVED_STALE_WEI = "5000000000000000"; // 0.005 ETH, reserved >15m, ages out
const RELEASED_WEI = "9000000000000000"; // 0.009 ETH, released, excluded
const PRIOR_DAY_WEI = "7000000000000000"; // 0.007 ETH, settled but before today
const OTHER_ORG_WEI = "500000000000000000"; // 0.5 ETH on another org, must not leak

// Only the three counted rows survive the WHERE clause.
const SCOPE_EXPECTED_WEI = (
  BigInt(SETTLED_TODAY_WEI) +
  BigInt(RESERVED_FRESH_WEI) +
  BigInt(DIRECT_COMPLETED_WEI)
).toString();

const MINUTE_MS = 60_000;

describe.skipIf(SKIP)("daily value-cap usage SUM", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getSpendCapData: (organizationId: string) => Promise<{
    dailyCapWei: string | null;
    dailyUsedWei: string;
    dailySolanaUsedLamports: string;
    effectiveDailyCapWei: string;
    usingDefaultDailyCap: boolean;
  }>;
  let getDefaultDailyValueCapWei: () => string;
  let defaultCapWei: string;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM org_value_reservations WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM direct_executions WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    // Every org here is "new" in the sense the report meant: none has ever
    // opened the spend-cap settings page, so none has an organization_spend_caps
    // row. getSpendCapData must still read a real usage figure for each.
    await db.insert(organization).values(
      [ORG_FRESH, ORG_ATCAP, ORG_SCOPE, ORG_OTHER].map((id) => ({
        id,
        name: id,
        slug: id,
        createdAt: now,
      }))
    );

    // ORG_ATCAP: a single settled reservation equal to the platform default,
    // moved earlier today. This is the exact shape that reads "used == cap" for
    // an org that looks idle right now - legitimate same-day spend the ledger
    // keeps for the rest of the UTC day, not a mis-initialised counter.
    ({ getDefaultDailyValueCapWei } = await import(
      "@/lib/execute/spend-cap-defaults"
    ));
    defaultCapWei = getDefaultDailyValueCapWei();

    await db.insert(orgValueReservations).values({
      id: `${PREFIX}atcap_settled`,
      organizationId: ORG_ATCAP,
      valueWei: defaultCapWei,
      status: "settled",
      createdAt: now,
    });

    // ORG_SCOPE: one row of every kind, so the SUM's WHERE clause is exercised
    // end to end. Counted: a settled reservation today, an in-flight reservation
    // younger than the stale window, and a completed direct execution (the other
    // store). Excluded: a reservation stuck reserved past the stale window (it
    // ages out - a dangling hold cannot own the cap all day), a released
    // reservation, and a reservation settled before today.
    await db.insert(orgValueReservations).values([
      {
        id: `${PREFIX}scope_settled_today`,
        organizationId: ORG_SCOPE,
        valueWei: SETTLED_TODAY_WEI,
        status: "settled",
        createdAt: now,
      },
      {
        id: `${PREFIX}scope_reserved_fresh`,
        organizationId: ORG_SCOPE,
        valueWei: RESERVED_FRESH_WEI,
        status: "reserved",
        createdAt: new Date(now.getTime() - 2 * MINUTE_MS),
      },
      {
        id: `${PREFIX}scope_reserved_stale`,
        organizationId: ORG_SCOPE,
        valueWei: RESERVED_STALE_WEI,
        status: "reserved",
        createdAt: new Date(now.getTime() - 30 * MINUTE_MS),
      },
      {
        id: `${PREFIX}scope_released`,
        organizationId: ORG_SCOPE,
        valueWei: RELEASED_WEI,
        status: "released",
        createdAt: now,
      },
      {
        id: `${PREFIX}scope_prior_day`,
        organizationId: ORG_SCOPE,
        valueWei: PRIOR_DAY_WEI,
        status: "settled",
        createdAt: new Date(now.getTime() - 24 * 60 * MINUTE_MS),
      },
    ]);

    await db.insert(directExecutions).values({
      id: `${PREFIX}scope_direct_completed`,
      organizationId: ORG_SCOPE,
      apiKeyId: `${PREFIX}key`,
      type: "contract-call",
      valueWei: DIRECT_COMPLETED_WEI,
      status: "completed",
      createdAt: now,
    });

    // ORG_OTHER: a large settled reservation that must never bleed into another
    // org's total.
    await db.insert(orgValueReservations).values({
      id: `${PREFIX}other_settled`,
      organizationId: ORG_OTHER,
      valueWei: OTHER_ORG_WEI,
      status: "settled",
      createdAt: now,
    });

    ({ getSpendCapData } = await import("@/lib/analytics/queries"));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("reads zero daily usage for a brand-new org with no activity", async () => {
    const data = await getSpendCapData(ORG_FRESH);

    // The regression the report describes: a fresh org reading its cap as
    // already spent. It must read exactly zero used, against the platform
    // default ceiling.
    expect(data.dailyUsedWei).toBe("0");
    expect(data.dailySolanaUsedLamports).toBe("0");
    expect(data.dailyCapWei).toBeNull();
    expect(data.usingDefaultDailyCap).toBe(true);
    expect(data.effectiveDailyCapWei).toBe(defaultCapWei);
    // used strictly below the cap - the enforcement path would admit a spend.
    expect(BigInt(data.dailyUsedWei) < BigInt(data.effectiveDailyCapWei)).toBe(
      true
    );
  });

  it("reads used == cap only when real same-day settled value equals the cap", async () => {
    const data = await getSpendCapData(ORG_ATCAP);

    // Reproduces the observed "used sits exactly at the cap" reading, and shows
    // it comes from an actual settled same-day reservation, not from seeding the
    // counter to the cap.
    expect(data.dailyUsedWei).toBe(defaultCapWei);
    expect(data.dailyUsedWei).toBe(data.effectiveDailyCapWei);
  });

  it("counts only in-scope rows across both stores", async () => {
    const data = await getSpendCapData(ORG_SCOPE);

    // settled-today + fresh-reserved + completed-direct, and nothing else: the
    // stale reservation ages out, the released row is gone, the prior-day row is
    // outside today, and ORG_OTHER's 0.5 ETH does not leak in.
    expect(data.dailyUsedWei).toBe(SCOPE_EXPECTED_WEI);
    // Only wei rows were seeded for this org, so the Solana total stays zero -
    // the two unit columns do not contaminate each other.
    expect(data.dailySolanaUsedLamports).toBe("0");
  });

  it("keeps one org's spend off another org's total", async () => {
    const fresh = await getSpendCapData(ORG_FRESH);
    const other = await getSpendCapData(ORG_OTHER);

    // ORG_OTHER carries its own 0.5 ETH; ORG_FRESH, sharing nothing, still reads
    // zero. Per-org scoping, stated as an isolation invariant.
    expect(other.dailyUsedWei).toBe(OTHER_ORG_WEI);
    expect(fresh.dailyUsedWei).toBe("0");
  });
});
