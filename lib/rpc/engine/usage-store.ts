import "server-only";

import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { organizationRpcUsageHourly } from "@/lib/db/schema-rpc";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { processSingleton } from "./process-singleton";
import { rpcUsageAccumulator } from "./runtime";
import type { RpcUsageAccumulator, RpcUsageBucket } from "./telemetry/usage";

const FLUSH_INTERVAL_MS = 30_000;

const table = organizationRpcUsageHourly;

function addExcluded(column: AnyPgColumn): SQL {
  return sql`${column} + excluded.${sql.identifier(column.name)}`;
}

function rowsFrom(buckets: readonly RpcUsageBucket[]) {
  return buckets.map((bucket) => ({
    organizationId: bucket.organizationId,
    configId: bucket.configId,
    origin: bucket.origin,
    chainId: bucket.chainId,
    transport: bucket.transport,
    hour: bucket.hour,
    requests: bucket.counters.requests,
    errors: bucket.counters.errors,
    timeouts: bucket.counters.timeouts,
    rateLimited: bucket.counters.rateLimited,
    failovers: bucket.counters.failovers,
    latencyMsSum: Math.round(bucket.counters.latencyMsSum),
    latencyMsMax: Math.round(bucket.counters.latencyMsMax),
    wsConnects: bucket.counters.wsConnects,
    wsReconnects: bucket.counters.wsReconnects,
    eventsReceived: bucket.counters.eventsReceived,
  }));
}

/**
 * Add every bucket recorded so far to the stored hourly rows. Buckets that
 * fail to write go back into the accumulator for the next flush.
 */
export async function flushRpcUsage(
  accumulator: RpcUsageAccumulator = rpcUsageAccumulator
): Promise<number> {
  const buckets = accumulator.drain();
  if (buckets.length === 0) {
    return 0;
  }
  try {
    await db
      .insert(table)
      .values(rowsFrom(buckets))
      .onConflictDoUpdate({
        target: [
          table.organizationId,
          table.configId,
          table.origin,
          table.chainId,
          table.transport,
          table.hour,
        ],
        set: {
          requests: addExcluded(table.requests),
          errors: addExcluded(table.errors),
          timeouts: addExcluded(table.timeouts),
          rateLimited: addExcluded(table.rateLimited),
          failovers: addExcluded(table.failovers),
          latencyMsSum: addExcluded(table.latencyMsSum),
          latencyMsMax: sql`greatest(${table.latencyMsMax}, excluded.${sql.identifier(table.latencyMsMax.name)})`,
          wsConnects: addExcluded(table.wsConnects),
          wsReconnects: addExcluded(table.wsReconnects),
          eventsReceived: addExcluded(table.eventsReceived),
        },
      });
    return buckets.length;
  } catch (error) {
    accumulator.restore(buckets);
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[RPC Engine] Failed to store RPC usage, will retry",
      error,
      { buckets: String(buckets.length) }
    );
    return 0;
  }
}

const flusher = processSingleton<{
  timer: ReturnType<typeof setInterval> | null;
}>("rpcUsageFlusher", () => ({ timer: null }));

/** Flush usage on an interval for the life of the process. Idempotent. */
export function startRpcUsageFlusher(): void {
  if (flusher.timer !== null) {
    return;
  }
  flusher.timer = setInterval(() => {
    flushRpcUsage().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
  flusher.timer.unref();
}
