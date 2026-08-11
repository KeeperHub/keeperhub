/**
 * Scan-funnel rate limiter: free burst + exponential backoff tail.
 *
 * Storage reuses the shared Postgres hourly-bucket counter table
 * (`agentic_wallet_rate_limits`) rather than adding a new table: scan rows
 * are namespaced by their `scan:` key prefix, the UPSERT pattern is identical
 * to lib/agentic-wallet/rate-limit.ts, and the existing
 * `agentic-wallet-sweeper` cron already deletes rows older than 24h. Only the
 * allow/deny policy differs, and that policy is scan-specific, so it lives
 * here instead of in the agentic-wallet module.
 */
import "server-only";

import { sql } from "drizzle-orm";
import type { RateLimitResult } from "@/lib/agentic-wallet/rate-limit";
import { db } from "@/lib/db";
import { agenticWalletRateLimits } from "@/lib/db/schema";

// Cap the backoff exponent so 2 ** n cannot overflow; any threshold past the
// hour boundary already behaves as "blocked until the bucket rolls over".
const MAX_BACKOFF_EXPONENT = 20;

/**
 * Hourly-bucket limiter with an exponential backoff tail instead of a hard
 * wall. The first `freeLimit` requests in the bucket pass immediately;
 * request freeLimit+n unlocks `baseSeconds * (2^n - 1)` seconds into the
 * bucket, so the spacing between allowed requests doubles each time
 * (base, 2*base, 4*base, ...) until the bucket rolls over.
 *
 * A denied attempt is refunded (request_count decremented) so retrying while
 * blocked reports the same retryAfter instead of escalating the schedule.
 */
export async function incrementAndCheckWithBackoff(
  key: string,
  freeLimit: number,
  baseSeconds: number
): Promise<RateLimitResult> {
  const rows = await db.execute<{
    request_count: number;
    bucket_epoch: number;
    now_epoch: number;
    next_bucket_epoch: number;
  }>(sql`
    INSERT INTO ${agenticWalletRateLimits} (key, bucket_start, request_count)
    VALUES (${key}, date_trunc('hour', now()), 1)
    ON CONFLICT (key, bucket_start)
    DO UPDATE SET request_count = ${agenticWalletRateLimits.requestCount} + 1
    RETURNING
      request_count,
      extract(epoch FROM date_trunc('hour', now()))::bigint AS bucket_epoch,
      extract(epoch FROM now())::bigint AS now_epoch,
      extract(epoch FROM date_trunc('hour', now()) + interval '1 hour')::bigint AS next_bucket_epoch
  `);

  const count = rows[0]?.request_count ?? 1;
  const reset = Number(rows[0]?.next_bucket_epoch ?? 0);
  const nowEpoch = Number(rows[0]?.now_epoch ?? Math.floor(Date.now() / 1000));
  const bucketEpoch = Number(rows[0]?.bucket_epoch ?? nowEpoch);
  const secondsToNextHour = Math.max(1, reset - nowEpoch);
  const remaining = Math.max(0, freeLimit - count);

  if (count <= freeLimit) {
    return { allowed: true, count, limit: freeLimit, remaining, reset };
  }

  const over = Math.min(count - freeLimit, MAX_BACKOFF_EXPONENT);
  const thresholdSeconds = baseSeconds * (2 ** over - 1);
  const elapsedSeconds = Math.max(0, nowEpoch - bucketEpoch);

  if (elapsedSeconds >= thresholdSeconds) {
    return { allowed: true, count, limit: freeLimit, remaining: 0, reset };
  }

  // Refund the denied attempt: the schedule should charge for served scans,
  // not for retries made while waiting.
  await db.execute(sql`
    UPDATE ${agenticWalletRateLimits}
    SET request_count = greatest(${agenticWalletRateLimits.requestCount} - 1, 0)
    WHERE ${agenticWalletRateLimits.key} = ${key}
      AND ${agenticWalletRateLimits.bucketStart} = date_trunc('hour', now())
  `);

  const retryAfter = Math.min(
    Math.max(1, thresholdSeconds - elapsedSeconds),
    secondsToNextHour
  );
  return {
    allowed: false,
    retryAfter,
    count,
    limit: freeLimit,
    remaining: 0,
    reset,
  };
}
