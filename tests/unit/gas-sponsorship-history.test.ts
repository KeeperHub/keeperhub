import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Queue of result sets returned by successive db.select(...) awaits. Each
// getMonthlySponsorship call issues two selects in order: persisted rollups,
// then the live ledger aggregate.
let selectQueue: unknown[][] = [];
const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);

// db.select() with no args is the persisted-rollups query (ends at .where());
// db.select({...}) is the ledger aggregate (ends at .groupBy()). Both pull the
// next queued result set when their terminal method runs.
vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => {
      const result = () => Promise.resolve(selectQueue.shift() ?? []);
      if (args.length > 0) {
        return { from: () => ({ where: () => ({ groupBy: result }) }) };
      }
      return { from: () => ({ where: result }) };
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: (...args: unknown[]) =>
          mockOnConflictDoNothing(...args),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  gasCreditUsage: {
    organizationId: "organization_id",
    createdAt: "created_at",
    chainId: "chain_id",
    gasCostWei: "gas_cost_wei",
    gasCostMicroUsd: "gas_cost_micro_usd",
  },
  gasSponsorshipMonthly: {
    organizationId: "organization_id",
    monthStart: "month_start",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
  gte: () => ({}),
  sql: () => ({}),
}));

import { getMonthlySponsorship } from "@/lib/billing/gas-sponsorship-history";

const ORG = "org_1";
const MAINNET = 1; // Ethereum
const TESTNET = 11_155_111; // Ethereum Sepolia

function monthKeyOffset(offset: number): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)
  );
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

beforeEach(() => {
  selectQueue = [];
  mockOnConflictDoNothing.mockClear();
});

describe("getMonthlySponsorship", () => {
  const currentKey = monthKeyOffset(0);
  const priorKey = monthKeyOffset(-1);

  function seed(): void {
    // persisted rollups: none yet (first read)
    selectQueue.push([]);
    // live ledger aggregate: prior month (closed) + current month, plus a
    // testnet row in the current month.
    selectQueue.push([
      {
        monthKey: priorKey,
        chainId: MAINNET,
        sponsoredWei: "1000",
        sponsoredMicroUsd: "5000",
        txCount: 2,
      },
      {
        monthKey: currentKey,
        chainId: MAINNET,
        sponsoredWei: "2000",
        sponsoredMicroUsd: "8000",
        txCount: 3,
      },
      {
        monthKey: currentKey,
        chainId: TESTNET,
        sponsoredWei: "500",
        sponsoredMicroUsd: "0",
        txCount: 1,
      },
    ]);
  }

  it("persists closed months and serves the current month live, newest first", async () => {
    seed();
    const months = await getMonthlySponsorship(ORG, { includeTestnets: false });

    expect(months.map((m) => m.monthStart.slice(0, 7))).toEqual([
      currentKey,
      priorKey,
    ]);
    // Only the closed month is rolled up (one insert batch).
    expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("excludes testnets by default and from the USD total", async () => {
    seed();
    const months = await getMonthlySponsorship(ORG, { includeTestnets: false });
    const current = months.find((m) => m.monthStart.startsWith(currentKey));

    expect(current?.byChain).toHaveLength(1);
    expect(current?.byChain[0].isTestnet).toBe(false);
    // Mainnet-only total; the testnet row's 0 is irrelevant but excluded.
    expect(current?.totalMicroUsd).toBe("8000");
  });

  it("includes testnets when requested but keeps the USD total mainnet-only", async () => {
    seed();
    const months = await getMonthlySponsorship(ORG, { includeTestnets: true });
    const current = months.find((m) => m.monthStart.startsWith(currentKey));

    expect(current?.byChain).toHaveLength(2);
    expect(current?.byChain.some((c) => c.isTestnet)).toBe(true);
    expect(current?.totalMicroUsd).toBe("8000");
  });
});
