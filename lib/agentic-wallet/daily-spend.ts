/**
 * Per-sub-org per-day spend cap for /sign (Phase 37 fix-pack-2 R1).
 *
 * Threat model: the Phase 37 workflowSlug binding closed the "caller supplies
 * arbitrary payTo" path, but an attacker with a stolen HMAC secret can still
 * list their OWN workflow at $49.99 (below the $50 ask-tier threshold in
 * risk.ts), point the stolen HMAC at it, and auto-tier-sign repeatedly. /sign
 * has no route-level rate limit, so without a spend cap the attack's only
 * upper bound is the EIP-3009 validity window.
 *
 * This primitive bounds total daily drain per sub-org via an atomic
 * reserve-and-rollback pattern:
 *
 *   1. /sign auto-tier calls reserveSpend() BEFORE the Turnkey round-trip.
 *   2. The UPSERT increments atomically; if the post-increment total exceeds
 *      the cap the spend is rolled back and the route returns 429.
 *   3. If Turnkey fails after a successful reserve, the route calls
 *      rollbackSpend() so transient upstream errors don't burn quota.
 *
 * UTC day boundary matches the sweeper retention pattern and avoids timezone
 * ambiguity. `date_trunc('day', now() AT TIME ZONE 'UTC')::date` is evaluated
 * server-side so the bucket key is identical across replicas.
 *
 * Cap: DEFAULT_DAILY_CAP_MICROS ($200 USDC) with env override
 * AGENTIC_WALLET_DAILY_CAP_MICROS for ops to tune without a deploy.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agenticWalletDailySpend } from "@/lib/db/schema";

export const DEFAULT_DAILY_CAP_MICROS: bigint = BigInt(200_000_000);

// Fix-pack-3 N-4: BigInt() accepts hex-prefixed strings ("0x10" → 16), so an
// ops typo like `AGENTIC_WALLET_DAILY_CAP_MICROS=0x10` would silently cap the
// entire feature at 0.000016 USDC/day. Reject anything that isn't a decimal
// digit run before handing it to BigInt.
const DECIMAL_INTEGER_RE = /^\d+$/;

export function getDailyCapMicros(): bigint {
  const raw = process.env.AGENTIC_WALLET_DAILY_CAP_MICROS;
  if (!raw) {
    return DEFAULT_DAILY_CAP_MICROS;
  }
  if (!DECIMAL_INTEGER_RE.test(raw)) {
    return DEFAULT_DAILY_CAP_MICROS;
  }
  try {
    const parsed = BigInt(raw);
    return parsed > BigInt(0) ? parsed : DEFAULT_DAILY_CAP_MICROS;
  } catch {
    return DEFAULT_DAILY_CAP_MICROS;
  }
}

export type ReserveResult =
  | { ok: true; totalAfterMicros: bigint; capMicros: bigint }
  | {
      ok: false;
      totalBeforeMicros: bigint;
      capMicros: bigint;
      retryAfter: number;
    };

function secondsUntilNextUtcMidnight(): number {
  const now = new Date();
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}

/**
 * Atomically add `amountMicros` to the sub-org's daily spent total. If the
 * resulting total exceeds the cap, roll back the increment and return
 * ok=false with retryAfter seconds until UTC midnight.
 *
 * Failure mode: if the UPSERT succeeds but the compensating rollback UPDATE
 * fails (e.g. DB connection dropped between statements), the counter is left
 * slightly over the actual spend. This is conservative — the legitimate
 * caller sees a spurious 429 until the bucket rolls, not a silent over-cap
 * sign. The sweeper retention window (2 days) ensures the stale counter
 * doesn't accumulate indefinitely.
 */
export async function reserveSpend(
  subOrgId: string,
  amountMicros: bigint
): Promise<ReserveResult> {
  if (amountMicros <= BigInt(0)) {
    return {
      ok: true,
      totalAfterMicros: BigInt(0),
      capMicros: getDailyCapMicros(),
    };
  }
  const cap = getDailyCapMicros();
  const amountStr = amountMicros.toString();

  const rows = await db.execute<{ spent_micros: string }>(sql`
    INSERT INTO ${agenticWalletDailySpend} (sub_org_id, day_utc, spent_micros)
    VALUES (
      ${subOrgId},
      (now() AT TIME ZONE 'UTC')::date,
      CAST(${amountStr} AS bigint)
    )
    ON CONFLICT (sub_org_id, day_utc)
    DO UPDATE SET spent_micros =
      ${agenticWalletDailySpend.spentMicros} + CAST(${amountStr} AS bigint)
    RETURNING spent_micros
  `);
  const totalAfter = BigInt(rows[0]?.spent_micros ?? "0");

  if (totalAfter > cap) {
    await db.execute(sql`
      UPDATE ${agenticWalletDailySpend}
      SET spent_micros = GREATEST(
        CAST(0 AS bigint),
        ${agenticWalletDailySpend.spentMicros} - CAST(${amountStr} AS bigint)
      )
      WHERE sub_org_id = ${subOrgId}
        AND day_utc = (now() AT TIME ZONE 'UTC')::date
    `);
    return {
      ok: false,
      totalBeforeMicros: totalAfter - amountMicros,
      capMicros: cap,
      retryAfter: secondsUntilNextUtcMidnight(),
    };
  }
  return { ok: true, totalAfterMicros: totalAfter, capMicros: cap };
}

/**
 * Decrement the sub-org's daily spent total by `amountMicros`. Called from
 * /sign after a Turnkey failure so a transient upstream error doesn't burn
 * the caller's quota.
 *
 * GREATEST(0, ...) guards against a race where two rollbacks for the same
 * reservation execute and the counter would otherwise go negative.
 */
export async function rollbackSpend(
  subOrgId: string,
  amountMicros: bigint
): Promise<void> {
  if (amountMicros <= BigInt(0)) {
    return;
  }
  const amountStr = amountMicros.toString();
  await db.execute(sql`
    UPDATE ${agenticWalletDailySpend}
    SET spent_micros = GREATEST(
      CAST(0 AS bigint),
      ${agenticWalletDailySpend.spentMicros} - CAST(${amountStr} AS bigint)
    )
    WHERE sub_org_id = ${subOrgId}
      AND day_utc = (now() AT TIME ZONE 'UTC')::date
  `);
}
