/**
 * Pure shaping for the RPC usage analytics: totals, the per-endpoint
 * breakdown, the time series and the endpoint labels. Client safe, so the
 * analytics page labels endpoints the same way the API groups them.
 */
import { RpcOrigin } from "@/lib/rpc/engine/types";
import type {
  RpcOwnOnlyChainUsage,
  RpcUsageBreakdownRow,
  RpcUsageBucket,
  RpcUsageSummary,
  RpcUsageTotals,
} from "./types";

/** One grouped row of `organization_rpc_usage_hourly`, already numeric. */
export type RpcUsageRow = {
  bucket: string;
  origin: RpcOrigin;
  configId: string | null;
  /** Null for KeeperHub endpoints and for configs that no longer exist. */
  configName: string | null;
  chainId: number;
  chainName: string | null;
  requests: number;
  errors: number;
  timeouts: number;
  rateLimited: number;
  failovers: number;
  latencyMsSum: number;
  latencyMsMax: number;
  wsConnects: number;
  wsReconnects: number;
  eventsReceived: number;
};

export const KEEPERHUB_ENDPOINT_LABEL = "KeeperHub";
export const REMOVED_CONFIG_LABEL = "Removed endpoint";

type Accumulator = Omit<RpcUsageTotals, "avgLatencyMs" | "maxLatencyMs"> & {
  latencyMsSum: number;
  latencyMsMax: number;
};

function emptyAccumulator(): Accumulator {
  return {
    requests: 0,
    errors: 0,
    timeouts: 0,
    rateLimited: 0,
    failovers: 0,
    latencyMsSum: 0,
    latencyMsMax: 0,
    wsConnects: 0,
    wsReconnects: 0,
    eventsReceived: 0,
  };
}

function accumulate(into: Accumulator, row: RpcUsageRow): void {
  into.requests += row.requests;
  into.errors += row.errors;
  into.timeouts += row.timeouts;
  into.rateLimited += row.rateLimited;
  into.failovers += row.failovers;
  into.latencyMsSum += row.latencyMsSum;
  into.latencyMsMax = Math.max(into.latencyMsMax, row.latencyMsMax);
  into.wsConnects += row.wsConnects;
  into.wsReconnects += row.wsReconnects;
  into.eventsReceived += row.eventsReceived;
}

function toTotals(acc: Accumulator): RpcUsageTotals {
  const { latencyMsSum, latencyMsMax, ...counts } = acc;
  const hasRequests = acc.requests > 0;
  return {
    ...counts,
    avgLatencyMs: hasRequests ? Math.round(latencyMsSum / acc.requests) : null,
    maxLatencyMs: hasRequests ? latencyMsMax : null,
  };
}

function isOwnEndpoint(row: { origin: RpcOrigin }): boolean {
  return row.origin === RpcOrigin.ORG;
}

export function summarizeRpcUsage(
  rows: readonly RpcUsageRow[]
): RpcUsageSummary {
  const acc = emptyAccumulator();
  let ownRequests = 0;
  for (const row of rows) {
    accumulate(acc, row);
    if (isOwnEndpoint(row)) {
      ownRequests += row.requests;
    }
  }
  return {
    ...toTotals(acc),
    ownRequests,
    platformRequests: acc.requests - ownRequests,
  };
}

function breakdownKey(row: RpcUsageRow): string {
  return `${row.origin}:${row.configId ?? ""}:${row.chainId}`;
}

/** Totals per endpoint and chain, busiest first. */
export function rpcUsageBreakdown(
  rows: readonly RpcUsageRow[]
): RpcUsageBreakdownRow[] {
  const groups = new Map<string, { first: RpcUsageRow; acc: Accumulator }>();
  for (const row of rows) {
    const key = breakdownKey(row);
    let group = groups.get(key);
    if (!group) {
      group = { first: row, acc: emptyAccumulator() };
      groups.set(key, group);
    }
    accumulate(group.acc, row);
  }
  const out: RpcUsageBreakdownRow[] = [];
  for (const { first, acc } of groups.values()) {
    const own = isOwnEndpoint(first);
    out.push({
      ...toTotals(acc),
      origin: first.origin,
      configId: own ? first.configId : null,
      configName: own ? first.configName : null,
      configRemoved: own && first.configName === null,
      chainId: first.chainId,
      chainName: first.chainName,
    });
  }
  return out.sort((a, b) => b.requests - a.requests || a.chainId - b.chainId);
}

/**
 * Requests per bucket by origin. With a skeleton every bucket in the window is
 * present; an empty skeleton (window too wide to fill) keeps only populated ones.
 */
export function rpcUsageBuckets(
  skeleton: readonly string[],
  rows: readonly RpcUsageRow[]
): RpcUsageBucket[] {
  const byTimestamp = new Map<string, RpcUsageBucket>();
  const bucketAt = (timestamp: string): RpcUsageBucket => {
    let bucket = byTimestamp.get(timestamp);
    if (!bucket) {
      bucket = { timestamp, ownRequests: 0, platformRequests: 0, errors: 0 };
      byTimestamp.set(timestamp, bucket);
    }
    return bucket;
  };
  for (const timestamp of skeleton) {
    bucketAt(timestamp);
  }
  for (const row of rows) {
    const bucket = bucketAt(new Date(row.bucket).toISOString());
    if (isOwnEndpoint(row)) {
      bucket.ownRequests += row.requests;
    } else {
      bucket.platformRequests += row.requests;
    }
    bucket.errors += row.errors;
  }
  return [...byTimestamp.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}

/** How the analytics page names an endpoint. */
export function rpcEndpointLabel(endpoint: {
  origin: RpcOrigin;
  configName: string | null;
}): string {
  if (!isOwnEndpoint(endpoint)) {
    return KEEPERHUB_ENDPOINT_LABEL;
  }
  return endpoint.configName ?? REMOVED_CONFIG_LABEL;
}

/** How the run details name the endpoint that served a step. */
export function rpcStepEndpointLabel(step: {
  rpcOrigin: RpcOrigin | null;
  rpcConfigName: string | null;
}): string | null {
  if (step.rpcOrigin === null) {
    return null;
  }
  if (step.rpcOrigin === RpcOrigin.ORG) {
    return `Your endpoint: ${step.rpcConfigName ?? REMOVED_CONFIG_LABEL.toLowerCase()}`;
  }
  return KEEPERHUB_ENDPOINT_LABEL;
}

/** Share of `part` in `total` as a 0..1 fraction, null when total is zero. */
export function shareOf(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

/**
 * For each chain set to own RPC only, how many requests KeeperHub endpoints
 * served on it in the range. Anything above zero is worth investigating.
 */
export function ownRpcOnlyChainUsage(
  rows: readonly RpcUsageRow[],
  chains: ReadonlyMap<number, string | null>
): RpcOwnOnlyChainUsage[] {
  const platformByChain = new Map<number, number>();
  for (const row of rows) {
    if (!isOwnEndpoint(row)) {
      platformByChain.set(
        row.chainId,
        (platformByChain.get(row.chainId) ?? 0) + row.requests
      );
    }
  }
  return [...chains.entries()]
    .sort(([a], [b]) => a - b)
    .map(([chainId, chainName]) => ({
      chainId,
      chainName,
      platformRequests: platformByChain.get(chainId) ?? 0,
    }));
}
