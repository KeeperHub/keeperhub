import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  gasCreditUsage,
  gasSponsorshipMonthly,
  type NewGasSponsorshipMonthly,
} from "@/lib/db/schema-extensions";
import {
  SPONSORSHIP_CHAINS,
  type SponsorshipChain,
} from "@/lib/web3/sponsorship-chains-meta";

export type ChainSponsorship = {
  chainId: number;
  name: string;
  isTestnet: boolean;
  sponsoredWei: string;
  sponsoredMicroUsd: string;
  txCount: number;
};

export type MonthlySponsorship = {
  /** First of the month, UTC, ISO string. */
  monthStart: string;
  /** Sum of mainnet sponsored USD (micro-USD) for the month. Testnets excluded. */
  totalMicroUsd: string;
  byChain: ChainSponsorship[];
};

// Keyed as `number`, not the literal chain ids: lookups come from DB rows,
// which can name a chain no longer on the sponsorship list.
const CHAIN_META: ReadonlyMap<number, SponsorshipChain> = new Map(
  SPONSORSHIP_CHAINS.map((c) => [c.chainId, c])
);

function chainName(chainId: number): string {
  return CHAIN_META.get(chainId)?.name ?? `Chain ${chainId}`;
}

function chainIsTestnet(chainId: number): boolean {
  return CHAIN_META.get(chainId)?.isTestnet ?? false;
}

function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function monthKeyToDate(key: string): Date {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

// Month boundaries are computed and stored as UTC midnight. The month_start
// column is a tz-naive `timestamp`; node-postgres reads it back in the server's
// local zone, so a non-UTC server could shift the exact-midnight value across a
// month boundary. Production runs UTC (and the rest of the schema uses bare
// `timestamp`), so this is consistent and safe.
function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type AggregateRow = {
  monthKey: string;
  chainId: number;
  sponsoredWei: string;
  sponsoredMicroUsd: string;
  txCount: number;
};

/**
 * Aggregate the per-tx ledger into (month, chain) buckets. `since` bounds the
 * scan to the not-yet-rolled-up tail so steady-state reads only touch the
 * current + most recent months.
 */
async function aggregateUsage(
  organizationId: string,
  since: Date | undefined
): Promise<AggregateRow[]> {
  const bucket = sql<string>`to_char(date_trunc('month', ${gasCreditUsage.createdAt}), 'YYYY-MM')`;
  const rows = await db
    .select({
      monthKey: bucket,
      chainId: gasCreditUsage.chainId,
      sponsoredWei: sql<string>`COALESCE(SUM(CAST(${gasCreditUsage.gasCostWei} AS NUMERIC)), 0)::text`,
      sponsoredMicroUsd: sql<string>`COALESCE(SUM(CAST(${gasCreditUsage.gasCostMicroUsd} AS NUMERIC)), 0)::text`,
      txCount: sql<number>`COUNT(*)::int`,
    })
    .from(gasCreditUsage)
    .where(
      and(
        eq(gasCreditUsage.organizationId, organizationId),
        since ? gte(gasCreditUsage.createdAt, since) : undefined
      )
    )
    .groupBy(bucket, gasCreditUsage.chainId);

  return rows.map((r) => ({
    monthKey: r.monthKey,
    chainId: r.chainId,
    sponsoredWei: r.sponsoredWei,
    sponsoredMicroUsd: r.sponsoredMicroUsd,
    txCount: Number(r.txCount),
  }));
}

function toChainSponsorship(row: {
  chainId: number;
  sponsoredWei: string;
  sponsoredMicroUsd: string;
  txCount: number;
}): ChainSponsorship {
  return {
    chainId: row.chainId,
    name: chainName(row.chainId),
    isTestnet: chainIsTestnet(row.chainId),
    sponsoredWei: row.sponsoredWei,
    sponsoredMicroUsd: row.sponsoredMicroUsd,
    txCount: row.txCount,
  };
}

function buildMonth(
  monthStart: Date,
  chains: ChainSponsorship[],
  includeTestnets: boolean
): MonthlySponsorship | null {
  const visible = includeTestnets ? chains : chains.filter((c) => !c.isTestnet);
  if (visible.length === 0) {
    return null;
  }
  const totalMicroUsd = visible
    .filter((c) => !c.isTestnet)
    .reduce((sum, c) => sum + BigInt(c.sponsoredMicroUsd || "0"), BigInt(0));
  visible.sort(
    (a, b) => Number(b.sponsoredMicroUsd) - Number(a.sponsoredMicroUsd)
  );
  return {
    monthStart: monthStart.toISOString(),
    totalMicroUsd: totalMicroUsd.toString(),
    byChain: visible,
  };
}

/**
 * Per-month, per-chain sponsored-gas history for an org. Closed months are
 * rolled up into gas_sponsorship_monthly once and served from there; the
 * current (open) month is always recomputed live from the ledger.
 *
 * Note this read persists closed-month rollups as a side effect (lazy
 * materialisation). The insert is idempotent via the unique constraint
 * (ON CONFLICT DO NOTHING), so concurrent first-reads are safe. It assumes a
 * closed month never gains new gas_credit_usage rows afterwards, which holds
 * because sponsorship usage is recorded synchronously at execution time, so a
 * row can never land in an already-rolled-up past month.
 *
 * Testnet chains are stored but only returned when `includeTestnets` is set;
 * their sponsored USD is 0, so the monthly USD total is mainnet-only.
 */
export async function getMonthlySponsorship(
  organizationId: string,
  { includeTestnets = false }: { includeTestnets?: boolean } = {}
): Promise<MonthlySponsorship[]> {
  const monthNow = currentMonthStart();

  const persisted = await db
    .select()
    .from(gasSponsorshipMonthly)
    .where(eq(gasSponsorshipMonthly.organizationId, organizationId));

  const persistedKeys = new Set(persisted.map((r) => monthKey(r.monthStart)));
  const latestPersisted = persisted.reduce<Date | undefined>(
    (max, r) => (max && max >= r.monthStart ? max : r.monthStart),
    undefined
  );

  const aggregates = await aggregateUsage(organizationId, latestPersisted);

  // Persist any closed month that has usage but is not yet rolled up.
  const toInsert: NewGasSponsorshipMonthly[] = [];
  for (const row of aggregates) {
    const start = monthKeyToDate(row.monthKey);
    const isClosed = start < monthNow;
    if (isClosed && !persistedKeys.has(row.monthKey)) {
      toInsert.push({
        organizationId,
        chainId: row.chainId,
        monthStart: start,
        sponsoredWei: row.sponsoredWei,
        sponsoredMicroUsd: row.sponsoredMicroUsd,
        txCount: row.txCount,
      });
    }
  }
  if (toInsert.length > 0) {
    await db
      .insert(gasSponsorshipMonthly)
      .values(toInsert)
      .onConflictDoNothing();
  }

  // Assemble per-month chain lists: persisted closed months + freshly computed
  // current month (+ any closed month just inserted this call).
  const byMonth = new Map<string, ChainSponsorship[]>();

  for (const r of persisted) {
    const key = monthKey(r.monthStart);
    const list = byMonth.get(key) ?? [];
    list.push(toChainSponsorship(r));
    byMonth.set(key, list);
  }

  for (const row of aggregates) {
    const start = monthKeyToDate(row.monthKey);
    const isClosed = start < monthNow;
    // Closed months are authoritative from `persisted`; only take the current
    // month live (and closed months not already persisted, e.g. first run).
    if (isClosed && persistedKeys.has(row.monthKey)) {
      continue;
    }
    const list = byMonth.get(row.monthKey) ?? [];
    list.push(toChainSponsorship(row));
    byMonth.set(row.monthKey, list);
  }

  const months: MonthlySponsorship[] = [];
  for (const [key, chains] of byMonth) {
    const month = buildMonth(monthKeyToDate(key), chains, includeTestnets);
    if (month) {
      months.push(month);
    }
  }
  months.sort((a, b) => b.monthStart.localeCompare(a.monthStart));
  return months;
}
