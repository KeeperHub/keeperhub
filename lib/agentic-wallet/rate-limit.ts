/**
 * Postgres-backed rate limiter. Per-(key, hour-bucket) counter via UPSERT.
 *
 * Phase 37 Wave 5 Task 20 replaces the in-memory limiter in
 * `lib/mcp/rate-limit.ts` for the `/provision` route. Hot-row contention is
 * acceptable at provision throughput (5/hour/IP). For higher-throughput
 * surfaces, shard the bucket key by minute or move to Redis.
 *
 * Cleanup: the `agentic-wallet-sweeper` cron deletes rows with
 * `bucket_start` older than 24h.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agenticWalletRateLimits } from "@/lib/db/schema";

export type RateLimitResult =
  | {
      allowed: true;
      count: number;
      limit: number;
      remaining: number;
      reset: number;
    }
  | {
      allowed: false;
      retryAfter: number;
      count: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export async function incrementAndCheck(
  key: string,
  limit: number
): Promise<RateLimitResult> {
  // Atomic UPSERT-and-increment in one statement. The unique key is
  // (key, bucket_start) so concurrent calls for the same IP within the
  // same hour bucket serialize on the row lock.
  // Derive the bucket boundary in the same Postgres session timezone that buckets
  // the row, so a non-UTC Node process can't compute a reset that diverges from
  // the actual hour boundary.
  const rows = await db.execute<{
    request_count: number;
    next_bucket_epoch: number;
  }>(sql`
    INSERT INTO ${agenticWalletRateLimits} (key, bucket_start, request_count)
    VALUES (${key}, date_trunc('hour', now()), 1)
    ON CONFLICT (key, bucket_start)
    DO UPDATE SET request_count = ${agenticWalletRateLimits.requestCount} + 1
    RETURNING
      request_count,
      extract(epoch FROM date_trunc('hour', now()) + interval '1 hour')::bigint AS next_bucket_epoch
  `);
  const count = rows[0]?.request_count ?? 1;

  // `reset` is the Unix-epoch second when the current hour bucket rolls over and
  // the counter resets. `Math.max(1, ...)` guards the edge case where the request
  // lands microseconds before the boundary and the delta would round to 0.
  const reset = Number(rows[0]?.next_bucket_epoch ?? 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const secondsToNextHour = Math.max(1, reset - nowSeconds);
  const remaining = Math.max(0, limit - count);

  if (count > limit) {
    return {
      allowed: false,
      retryAfter: secondsToNextHour,
      count,
      limit,
      remaining: 0,
      reset,
    };
  }
  return { allowed: true, count, limit, remaining, reset };
}
