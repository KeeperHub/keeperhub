import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { directExecutions, workflowExecutions } from "@/lib/db/schema";

/**
 * Shared concurrency back-pressure check. Server-only-free and db-agnostic so
 * both the Next routes (via app/api/execute/_lib/concurrency-limit) and the
 * standalone executor enforce the same cap regardless of execution mode.
 */

const DEFAULT_LIMIT = 500;
const DEFAULT_DIRECT_LIMIT = 100;
// In-flight rows older than this are treated as stale (crashed pod / lost
// process) and excluded from the count, so a stuck row cannot permanently
// consume a slot. On-chain broadcast + confirmation is seconds to a couple of
// minutes; 15m is a comfortable upper bound for a legitimate in-flight row.
const DIRECT_STALE_MINUTES = 15;

export function resolveMaxConcurrent(): number {
  const envValue = process.env.MAX_CONCURRENT_WORKFLOW_EXECUTIONS;
  if (!envValue) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isNaN(parsed) ? DEFAULT_LIMIT : parsed;
}

export function resolveMaxConcurrentDirect(): number {
  const envValue = process.env.MAX_CONCURRENT_DIRECT_EXECUTIONS;
  if (!envValue) {
    return DEFAULT_DIRECT_LIMIT;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isNaN(parsed) ? DEFAULT_DIRECT_LIMIT : parsed;
}

export type ConcurrencyLimitResult =
  | { allowed: true }
  | { allowed: false; running: number; limit: number };

/**
 * Soft cap: the count-then-admit check is not atomic, so under burst load
 * concurrent callers may all pass before any new execution is inserted. The
 * goal is back-pressure, not a hard guarantee.
 */
export async function checkConcurrencyLimit<
  TSchema extends Record<string, unknown>,
>(
  db: PostgresJsDatabase<TSchema>,
  limit: number = resolveMaxConcurrent()
): Promise<ConcurrencyLimitResult> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.status, "running"));

  const running = result?.count ?? 0;

  if (running >= limit) {
    return { allowed: false, running, limit };
  }

  return { allowed: true };
}

/**
 * Back-pressure for the direct execution API, scoped to one organization so a
 * single org's burst cannot throttle other tenants. Counts that org's in-flight
 * on-chain direct executions (pending/running with a network, created within the
 * stale window). The network filter matches what the write routes gate (off-chain
 * node executions are not gated, so they must not consume slots either), and the
 * time window means a crashed/stuck row ages out instead of holding a slot
 * forever. Same soft-cap caveat as checkConcurrencyLimit: count-then-admit is not
 * atomic.
 */
export async function checkDirectExecutionConcurrency<
  TSchema extends Record<string, unknown>,
>(
  db: PostgresJsDatabase<TSchema>,
  organizationId: string,
  limit: number = resolveMaxConcurrentDirect()
): Promise<ConcurrencyLimitResult> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        isNotNull(directExecutions.network),
        // An unconfirmed row is a broadcast still in flight on chain, so it
        // holds a slot like any other in-flight execution until it settles.
        inArray(directExecutions.status, ["pending", "running", "unconfirmed"]),
        sql`${directExecutions.createdAt} > now() - interval '${sql.raw(String(DIRECT_STALE_MINUTES))} minutes'`
      )
    );

  const running = result?.count ?? 0;

  if (running >= limit) {
    return { allowed: false, running, limit };
  }

  return { allowed: true };
}
