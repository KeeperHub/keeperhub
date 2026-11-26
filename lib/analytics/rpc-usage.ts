import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import {
  organizationRpcChainPolicy,
  organizationRpcConfigs,
  organizationRpcUsageHourly,
} from "@/lib/db/schema-rpc";
import type { RpcOrigin } from "@/lib/rpc/engine/types";
import { HOUR_MS } from "@/lib/utils/duration";
import { analyticsCacheKey, cachedAnalytics } from "./cache";
import { bucketSkeleton, bucketSql, isCacheableRange } from "./queries";
import {
  ownRpcOnlyChainUsage,
  type RpcUsageRow,
  rpcUsageBreakdown,
  rpcUsageBuckets,
  summarizeRpcUsage,
} from "./rpc-usage-shape";
import {
  type BucketInterval,
  getBucketInterval,
  getTimeRangeWindow,
} from "./time-range";
import type { RpcUsageResponse, TimeRange } from "./types";

const HOURLY: BucketInterval = { intervalMs: HOUR_MS, sqlInterval: "1 hour" };

/** Usage is stored per hour, so no bucket is narrower than one. */
export function rpcUsageBucketInterval(windowMs: number): BucketInterval {
  const interval = getBucketInterval(windowMs);
  return interval.intervalMs < HOUR_MS ? HOURLY : interval;
}

/** The stored hour a window start falls in, so a partial first hour counts. */
export function rpcUsageWindowStart(start: Date): Date {
  return new Date(Math.floor(start.getTime() / HOUR_MS) * HOUR_MS);
}

type RawRpcUsageRow = {
  bucket: string | Date;
  origin: RpcOrigin;
  configId: string | null;
  configName: string | null;
  chainId: number;
  chainName: string | null;
  requests: string | number | null;
  errors: string | number | null;
  timeouts: string | number | null;
  rateLimited: string | number | null;
  failovers: string | number | null;
  latencyMsSum: string | number | null;
  latencyMsMax: string | number | null;
  wsConnects: string | number | null;
  wsReconnects: string | number | null;
  eventsReceived: string | number | null;
};

function toCount(value: string | number | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parseRpcUsageRow(row: RawRpcUsageRow): RpcUsageRow {
  return {
    bucket: new Date(row.bucket).toISOString(),
    origin: row.origin,
    configId: row.configId,
    configName: row.configName,
    chainId: row.chainId,
    chainName: row.chainName,
    requests: toCount(row.requests),
    errors: toCount(row.errors),
    timeouts: toCount(row.timeouts),
    rateLimited: toCount(row.rateLimited),
    failovers: toCount(row.failovers),
    latencyMsSum: toCount(row.latencyMsSum),
    latencyMsMax: toCount(row.latencyMsMax),
    wsConnects: toCount(row.wsConnects),
    wsReconnects: toCount(row.wsReconnects),
    eventsReceived: toCount(row.eventsReceived),
  };
}

/** The chains set to own RPC only, with their names. */
async function loadOwnRpcOnlyChainNames(
  organizationId: string
): Promise<Map<number, string | null>> {
  const policy = organizationRpcChainPolicy;
  const rows = await db
    .select({ chainId: policy.chainId, chainName: chains.name })
    .from(policy)
    .leftJoin(chains, eq(chains.chainId, policy.chainId))
    .where(
      and(
        eq(policy.organizationId, organizationId),
        eq(policy.ownRpcOnly, true)
      )
    );
  return new Map(rows.map((row) => [row.chainId, row.chainName]));
}

async function loadRpcUsageRows(
  organizationId: string,
  start: Date,
  end: Date,
  interval: BucketInterval,
  timeZone: string
): Promise<RpcUsageRow[]> {
  const usage = organizationRpcUsageHourly;
  const bucketExpr = bucketSql(interval.sqlInterval, timeZone)(usage.hour);
  const rows = await db
    .select({
      bucket: sql<string>`${bucketExpr}`,
      origin: usage.origin,
      configId: usage.configId,
      configName: organizationRpcConfigs.name,
      chainId: usage.chainId,
      chainName: chains.name,
      requests: sql<string>`SUM(${usage.requests})`,
      errors: sql<string>`SUM(${usage.errors})`,
      timeouts: sql<string>`SUM(${usage.timeouts})`,
      rateLimited: sql<string>`SUM(${usage.rateLimited})`,
      failovers: sql<string>`SUM(${usage.failovers})`,
      latencyMsSum: sql<string>`SUM(${usage.latencyMsSum})`,
      latencyMsMax: sql<string>`MAX(${usage.latencyMsMax})`,
      wsConnects: sql<string>`SUM(${usage.wsConnects})`,
      wsReconnects: sql<string>`SUM(${usage.wsReconnects})`,
      eventsReceived: sql<string>`SUM(${usage.eventsReceived})`,
    })
    .from(usage)
    // A removed config keeps its usage rows; the join just finds no name.
    .leftJoin(
      organizationRpcConfigs,
      and(
        eq(organizationRpcConfigs.id, usage.configId),
        eq(organizationRpcConfigs.organizationId, usage.organizationId)
      )
    )
    .leftJoin(chains, eq(chains.chainId, usage.chainId))
    .where(
      and(
        eq(usage.organizationId, organizationId),
        gte(usage.hour, rpcUsageWindowStart(start)),
        lt(usage.hour, end)
      )
    )
    // Bucket by ordinal: the zone is a bound parameter (see getTimeSeries).
    .groupBy(
      sql`1`,
      usage.origin,
      usage.configId,
      organizationRpcConfigs.name,
      usage.chainId,
      chains.name
    )
    .orderBy(sql`1 ASC`);
  return rows.map(parseRpcUsageRow);
}

async function computeRpcUsage(
  organizationId: string,
  range: TimeRange,
  customStart: string | undefined,
  customEnd: string | undefined,
  timeZone: string
): Promise<RpcUsageResponse> {
  const { start, end } = getTimeRangeWindow(range, customStart, customEnd);
  const interval = rpcUsageBucketInterval(end.getTime() - start.getTime());
  const [rows, ownRpcOnlyChains, skeleton] = await Promise.all([
    loadRpcUsageRows(organizationId, start, end, interval, timeZone),
    loadOwnRpcOnlyChainNames(organizationId),
    bucketSkeleton(
      start,
      end,
      interval.intervalMs,
      interval.sqlInterval,
      timeZone
    ),
  ]);
  return {
    summary: summarizeRpcUsage(rows),
    ownRpcOnlyChains: ownRpcOnlyChainUsage(rows, ownRpcOnlyChains),
    buckets: rpcUsageBuckets(skeleton, rows),
    intervalMs: interval.intervalMs,
    breakdown: rpcUsageBreakdown(rows),
  };
}

/**
 * RPC usage for the analytics page. Named ranges are cached per (org, range,
 * zone); custom ranges bypass the cache (see isCacheableRange).
 */
export function getRpcUsage(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  timeZone = "UTC"
): Promise<RpcUsageResponse> {
  const compute = (): Promise<RpcUsageResponse> =>
    computeRpcUsage(organizationId, range, customStart, customEnd, timeZone);
  if (!isCacheableRange(range, customStart, customEnd)) {
    return compute();
  }
  return cachedAnalytics(
    analyticsCacheKey("rpc-usage", [organizationId, range, timeZone]),
    compute
  );
}
