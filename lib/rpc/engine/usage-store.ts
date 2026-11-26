import "server-only";

import { inArray, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { isForeignKeyViolation } from "@/lib/db/errors";
import { organization } from "@/lib/db/schema";
import { organizationRpcUsageHourly } from "@/lib/db/schema-rpc";
import { ErrorCategory, logSystemWarn, logWarn } from "@/lib/logging";
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

async function writeBuckets(buckets: readonly RpcUsageBucket[]): Promise<void> {
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
}

function byOrganization(
  buckets: readonly RpcUsageBucket[]
): RpcUsageBucket[][] {
  const groups = new Map<string, RpcUsageBucket[]>();
  for (const bucket of buckets) {
    const group = groups.get(bucket.organizationId) ?? [];
    group.push(bucket);
    groups.set(bucket.organizationId, group);
  }
  return [...groups.values()];
}

/**
 * Write each organization's buckets on its own, so one organization that no
 * longer exists cannot block the rest. Its buckets are dropped; other
 * failures go back for the next flush.
 */
async function writeEachOrganization(
  buckets: readonly RpcUsageBucket[],
  accumulator: RpcUsageAccumulator
): Promise<number> {
  let written = 0;
  let dropped = 0;
  for (const group of byOrganization(buckets)) {
    try {
      await writeBuckets(group);
      written += group.length;
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        dropped += group.length;
        continue;
      }
      accumulator.restore(group);
      logSystemWarn(
        ErrorCategory.DATABASE,
        "[RPC Engine] Failed to store RPC usage, will retry",
        error,
        { buckets: String(group.length) }
      );
    }
  }
  if (dropped > 0) {
    logWarn(
      "[RPC Engine] Dropped RPC usage for organizations that no longer exist",
      {
        buckets: String(dropped),
      }
    );
  }
  return written;
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
    await writeBuckets(buckets);
    return buckets.length;
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return await writeEachOrganization(buckets, accumulator);
    }
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

/** The buckets whose organization exists; the rest are dropped. */
export async function bucketsForKnownOrganizations(
  buckets: readonly RpcUsageBucket[]
): Promise<RpcUsageBucket[]> {
  const ids = [...new Set(buckets.map((bucket) => bucket.organizationId))];
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(inArray(organization.id, ids));
  const known = new Set(rows.map((row) => row.id));
  return buckets.filter((bucket) => known.has(bucket.organizationId));
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
