import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Shared, server-only-free core for the monthly execution-limit check. Both the
 * Next billing path (lib/billing/plans-server.ts) and the standalone executor
 * (keeperhub-executor/billing-guard.ts) use these so the count query and the
 * allow/overage/block decision cannot drift. Each caller keeps its own result
 * shape and its own debt source (the route's is Stripe-aware and server-only;
 * the executor's is a plain active-debt sum), which is why those stay per-side.
 */

export const MINIMUM_EXECUTION_FLOOR = 100;

export function startOfCurrentMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function effectiveExecutionLimit(
  maxExecutionsPerMonth: number,
  debtExecutions: number
): number {
  return Math.max(
    MINIMUM_EXECUTION_FLOOR,
    maxExecutionsPerMonth - debtExecutions
  );
}

/**
 * Count an org's billable executions in the current month: billable workflow
 * executions plus direct (MCP/API) executions. Raw SQL (rather than the query
 * builder) so the same statement runs identically under the app db and the
 * executor's standalone db handle.
 */
export async function countMonthlyExecutions<
  TSchema extends Record<string, unknown>,
>(
  db: PostgresJsDatabase<TSchema>,
  organizationId: string,
  since: Date = startOfCurrentMonthUtc()
): Promise<number> {
  const result = await db.execute<{ count: number }>(
    sql`SELECT
          (
            SELECT COUNT(*)::int
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${since.toISOString()}
               AND we.billable = TRUE
          )
          +
          (
            SELECT COUNT(*)::int
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${since.toISOString()}
          ) AS count`
  );

  return result[0]?.count ?? 0;
}

const DEFAULT_COUNT_CACHE_TTL_MS = 30_000;

function getCountCacheTtlMs(): number {
  const raw = process.env.BILLING_COUNT_CACHE_TTL_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_COUNT_CACHE_TTL_MS;
  }
  // Number() (not parseInt) so trailing junk like "30s" is rejected outright
  // rather than silently parsed as 30, which would be a 1000x-wrong TTL.
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_COUNT_CACHE_TTL_MS;
}

type CountCacheEntry = {
  // Monotonic timestamps from performance.now(): wall-clock can step backwards
  // on NTP adjustments and invalidate the TTL math.
  completedAt: number | null;
  promise: Promise<number>;
};

const countCache = new Map<string, CountCacheEntry>();

type CountRead = {
  count: number;
  // True when this read started a scan or joined one already in flight, i.e.
  // no fresher value is obtainable right now.
  fresh: boolean;
};

/**
 * countMonthlyExecutions behind a per-process TTL cache with in-flight dedup.
 *
 * The guard runs per SQS message / per execute request, but the count it
 * recomputes moves by at most the message throughput - recomputing an
 * O(org monthly executions) aggregate for a number that changes by 1 is what
 * let a single large org's slow count stack 15-20 concurrent 30s scans and
 * stall every org's triggered executions. Within the TTL all callers for an
 * org share one result, and while a refresh is in flight (even past the TTL,
 * i.e. under DB stress) they share the same promise instead of each starting
 * their own scan.
 *
 * ttlMs 0 keeps the in-flight sharing but never serves a completed value, which
 * is how admission re-reads at the limit without letting concurrent callers
 * stack scans. BILLING_COUNT_CACHE_TTL_MS=0 puts every read on that footing.
 *
 * For admission control only. The paths that turn a count into money - overage
 * billing (lib/billing/overage.ts) and the invoice usage figures
 * (lib/billing/execution-usage.ts) - read the exact committed count for their
 * own billing period with their own query, and never come through here.
 */
async function readCount<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  organizationId: string,
  since: Date,
  ttlMs: number
): Promise<CountRead> {
  // Keyed on the window start as well as the org so a month rollover starts a
  // fresh count instead of serving the old month's total.
  const key = `${organizationId}|${since.toISOString()}`;
  const existing = countCache.get(key);
  if (existing) {
    // An in-flight scan is shared even at ttl 0: it is already as fresh as a
    // new scan, and sharing is what keeps concurrent admissions from stacking
    // duplicate scans over one org.
    if (existing.completedAt === null) {
      return { count: await existing.promise, fresh: true };
    }
    if (ttlMs > 0 && performance.now() - existing.completedAt < ttlMs) {
      return { count: await existing.promise, fresh: false };
    }
  }

  const promise = countMonthlyExecutions(db, organizationId, since);
  const entry: CountCacheEntry = { completedAt: null, promise };
  countCache.set(key, entry);

  // Bookkeeping only. The two-arg form avoids creating an orphan rejected
  // promise (which would surface as an unhandled rejection); failures evict
  // the slot so the next caller retries instead of seeing a pinned error.
  promise
    .then(
      () => {
        entry.completedAt = performance.now();
      },
      () => {
        if (countCache.get(key) === entry) {
          countCache.delete(key);
        }
      }
    )
    .catch(() => {
      // settle callback threw; nothing actionable here
    });

  return { count: await promise, fresh: true };
}

/**
 * How far from the limit admission stops trusting a cached count. Sized above
 * the largest burst one org has fitted into a single TTL window, so a burst
 * cannot jump the band from underneath it.
 */
export const ADMISSION_RECOUNT_MARGIN = 500;

/**
 * The count to admit or refuse an execution on.
 *
 * Plans that bill overage keep the cache: going over there is charged, so a
 * stale count costs nothing. Without overage an over-limit run is admitted for
 * free, so near the limit the count is re-read instead.
 *
 * The band closes above the limit too. A pay-as-you-go org runs well past its
 * included executions, and once it is clearly over, a stale count gives the
 * same answer, so it returns to the cache rather than re-reading forever.
 *
 * Simultaneous in-flight admissions still share one count and can each be
 * admitted at the boundary. That is the check-then-act window; closing it needs
 * an atomic count-and-reserve, not a fresher read.
 */
export async function countMonthlyExecutionsForAdmission<
  TSchema extends Record<string, unknown>,
>(
  db: PostgresJsDatabase<TSchema>,
  organizationId: string,
  plan: { maxExecutionsPerMonth: number; overageEnabled: boolean },
  since: Date = startOfCurrentMonthUtc()
): Promise<number> {
  const read = await readCount(db, organizationId, since, getCountCacheTtlMs());
  if (
    read.fresh ||
    plan.overageEnabled ||
    plan.maxExecutionsPerMonth < 0 ||
    Math.abs(read.count - plan.maxExecutionsPerMonth) > ADMISSION_RECOUNT_MARGIN
  ) {
    return read.count;
  }
  return (await readCount(db, organizationId, since, 0)).count;
}

/**
 * Clear the cache. Test-only - throws outside NODE_ENV=test so production code
 * that calls it by mistake fails loud instead of silently dropping the cache.
 */
export function __resetExecutionCountCacheForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__resetExecutionCountCacheForTest is test-only; do not call in production"
    );
  }
  countCache.clear();
}

export type ExecutionLimitOutcome =
  | "blocked_debt"
  | "within_limit"
  | "overage"
  | "blocked_limit";

/**
 * The allow/overage/block decision for a non-unlimited plan. Callers handle the
 * unlimited (maxExecutionsPerMonth === -1) case before reaching here, since it
 * intentionally skips the debt and count queries.
 */
export function decideExecutionLimit(params: {
  maxExecutionsPerMonth: number;
  used: number;
  debtExecutions: number;
  overageEnabled: boolean;
  subscriptionActive: boolean;
}): ExecutionLimitOutcome {
  if (params.debtExecutions > 0 && params.overageEnabled) {
    return "blocked_debt";
  }
  if (params.used < params.maxExecutionsPerMonth) {
    return "within_limit";
  }
  if (params.overageEnabled && params.subscriptionActive) {
    return "overage";
  }
  return "blocked_limit";
}
