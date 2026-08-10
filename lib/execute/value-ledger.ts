import "server-only";

import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  directExecutions,
  organizationSpendCaps,
  orgValueReservations,
} from "@/lib/db/schema-extensions";
import { parseNodeNativeValueWei } from "@/lib/execute/reserved-value";

// In-flight rows older than this are treated as stale (crashed pod / lost
// process) and drop out of the cap SUM, matching the direct-execution
// concurrency limiter, so a stuck reservation cannot hold the cap all day.
// Unconfirmed rows are exempt: the transaction is on chain and may have moved
// the funds, so it keeps counting until the reconciler settles it.
const STALE_INFLIGHT_MINUTES = 15;

// biome-ignore lint/suspicious/noExplicitAny: accept either the app db or a tx
type Executor = any;

/**
 * Total native value (wei) an org has moved / has in-flight today, summed across
 * BOTH stores so every path counts against the same cap: direct-execution rows
 * (`direct_executions.value_wei`, set by the direct API routes) and the value
 * ledger (`org_value_reservations`, set by workflow + protocol executions).
 *
 * Settled/completed rows count for the whole UTC day; in-flight (pending/running
 * or reserved) rows only within the stale window, so a stuck row ages out.
 * Runs inside the caller's transaction so it is consistent with the FOR UPDATE.
 */
export async function sumOrgValueTodayWei(
  executor: Executor,
  organizationId: string
): Promise<bigint> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const directRows = await executor
    .select({
      totalWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.valueWei} AS NUMERIC)), 0)::text`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        ne(directExecutions.status, "failed"),
        gte(directExecutions.createdAt, todayStart),
        sql`(${directExecutions.status} IN ('completed', 'unconfirmed') OR ${directExecutions.createdAt} > now() - interval '${sql.raw(String(STALE_INFLIGHT_MINUTES))} minutes')`
      )
    );

  const ledgerRows = await executor
    .select({
      totalWei: sql<string>`COALESCE(SUM(CAST(${orgValueReservations.valueWei} AS NUMERIC)), 0)::text`,
    })
    .from(orgValueReservations)
    .where(
      and(
        eq(orgValueReservations.organizationId, organizationId),
        ne(orgValueReservations.status, "released"),
        gte(orgValueReservations.createdAt, todayStart),
        sql`(${orgValueReservations.status} = 'settled' OR ${orgValueReservations.createdAt} > now() - interval '${sql.raw(String(STALE_INFLIGHT_MINUTES))} minutes')`
      )
    );

  const direct = BigInt(directRows[0]?.totalWei ?? "0");
  const ledger = BigInt(ledgerRows[0]?.totalWei ?? "0");
  return direct + ledger;
}

/**
 * Total native value (LAMPORTS) an org has moved / has in-flight today on
 * Solana, summed across both stores. The Solana twin of `sumOrgValueTodayWei`,
 * with identical staleness and status semantics.
 *
 * Sums the dedicated `value_lamports` columns rather than sharing `value_wei`:
 * the two are different units (1e9 vs 1e18), so one column would add the scales
 * together and understate usage against whichever cap was being checked. Rows
 * belonging to the other chain family contribute NULL, which COALESCE folds to
 * 0, so the two totals never contaminate each other.
 */
export async function sumOrgSolanaValueTodayLamports(
  executor: Executor,
  organizationId: string
): Promise<bigint> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const directRows = await executor
    .select({
      totalLamports: sql<string>`COALESCE(SUM(CAST(${directExecutions.valueLamports} AS NUMERIC)), 0)::text`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        ne(directExecutions.status, "failed"),
        gte(directExecutions.createdAt, todayStart),
        sql`(${directExecutions.status} IN ('completed', 'unconfirmed') OR ${directExecutions.createdAt} > now() - interval '${sql.raw(String(STALE_INFLIGHT_MINUTES))} minutes')`
      )
    );

  const ledgerRows = await executor
    .select({
      totalLamports: sql<string>`COALESCE(SUM(CAST(${orgValueReservations.valueLamports} AS NUMERIC)), 0)::text`,
    })
    .from(orgValueReservations)
    .where(
      and(
        eq(orgValueReservations.organizationId, organizationId),
        ne(orgValueReservations.status, "released"),
        gte(orgValueReservations.createdAt, todayStart),
        sql`(${orgValueReservations.status} = 'settled' OR ${orgValueReservations.createdAt} > now() - interval '${sql.raw(String(STALE_INFLIGHT_MINUTES))} minutes')`
      )
    );

  const direct = BigInt(directRows[0]?.totalLamports ?? "0");
  const ledger = BigInt(ledgerRows[0]?.totalLamports ?? "0");
  return direct + ledger;
}

/**
 * The org's total value moved today (wei) across both stores, for read-only
 * surfaces (the dashboard gauge). Uses the app db, not a transaction.
 */
export function getOrgValueUsedTodayWei(
  organizationId: string
): Promise<bigint> {
  return sumOrgValueTodayWei(db, organizationId);
}

export type ReserveResult =
  | { allowed: true; reservationId: string }
  | { allowed: false; reason: string };

type ReserveParams = {
  organizationId: string;
  // Native value being moved, in wei.
  valueWei: string;
  // Origin of the execution and a correlation id, for audit only.
  source?: string;
  ref?: string;
};

/**
 * Atomically check the org's daily value cap and reserve `valueWei` against it,
 * recording into the value ledger. Shared by the value-moving paths that are not
 * the direct-execution API (workflow steps, protocol writes) so the cap cannot
 * be bypassed by using a different entrance.
 *
 * A `SELECT ... FOR UPDATE` on the cap row serializes per org (the same row the
 * direct routes lock, so direct + workflow reservations serialize together); the
 * day's value across BOTH stores is summed; the request is denied if it would
 * push the total over the cap; otherwise a `reserved` ledger row is inserted so
 * concurrent callers see it (closing the TOCTOU). When the org has no cap,
 * nothing is recorded (unlimited) and the empty reservationId makes settle/
 * release a no-op.
 */
export async function reserveOrgValue(
  params: ReserveParams
): Promise<ReserveResult> {
  return await db.transaction(async (tx) => {
    const caps = await tx
      .select({ dailyValueCapWei: organizationSpendCaps.dailyValueCapWei })
      .from(organizationSpendCaps)
      .where(eq(organizationSpendCaps.organizationId, params.organizationId))
      .for("update")
      .limit(1);

    const cap = caps[0];

    // No cap configured -> unlimited; record nothing.
    if (!cap || cap.dailyValueCapWei === null) {
      return { allowed: true, reservationId: "" } as const;
    }

    const totalWei = await sumOrgValueTodayWei(tx, params.organizationId);
    const reservedWei = BigInt(params.valueWei);
    const dailyCap = BigInt(cap.dailyValueCapWei);

    if (totalWei + reservedWei > dailyCap) {
      return { allowed: false, reason: "Daily spending cap exceeded" } as const;
    }

    const [row] = await tx
      .insert(orgValueReservations)
      .values({
        organizationId: params.organizationId,
        valueWei: params.valueWei,
        status: "reserved",
        source: params.source ?? null,
        ref: params.ref ?? null,
      })
      .returning({ id: orgValueReservations.id });

    return { allowed: true, reservationId: row.id } as const;
  });
}

type ReserveSolanaParams = {
  organizationId: string;
  // Native value being moved, in lamports.
  valueLamports: string;
  source?: string;
  ref?: string;
};

/**
 * Atomically check the org's daily Solana value cap and reserve `valueLamports`
 * against it, recording into the value ledger. Workflow twin of the lamports
 * branch in checkAndReserveExecution.
 */
export async function reserveOrgSolanaValue(
  params: ReserveSolanaParams
): Promise<ReserveResult> {
  return await db.transaction(async (tx) => {
    const caps = await tx
      .select({
        dailySolanaValueCapLamports:
          organizationSpendCaps.dailySolanaValueCapLamports,
      })
      .from(organizationSpendCaps)
      .where(eq(organizationSpendCaps.organizationId, params.organizationId))
      .for("update")
      .limit(1);

    const cap = caps[0];

    if (!cap || cap.dailySolanaValueCapLamports === null) {
      return { allowed: true, reservationId: "" } as const;
    }

    const totalLamports = await sumOrgSolanaValueTodayLamports(
      tx,
      params.organizationId
    );
    const reservedLamports = BigInt(params.valueLamports);
    const dailyCap = BigInt(cap.dailySolanaValueCapLamports);

    if (totalLamports + reservedLamports > dailyCap) {
      return {
        allowed: false,
        reason: "Daily Solana spending cap exceeded",
      } as const;
    }

    const [row] = await tx
      .insert(orgValueReservations)
      .values({
        organizationId: params.organizationId,
        valueWei: "0",
        valueLamports: params.valueLamports,
        status: "reserved",
        source: params.source ?? null,
        ref: params.ref ?? null,
      })
      .returning({ id: orgValueReservations.id });

    return { allowed: true, reservationId: row.id } as const;
  });
}

/** Mark a reservation as settled (broadcast succeeded); it counts all day. */
export async function settleReservation(reservationId: string): Promise<void> {
  if (!reservationId) {
    return;
  }
  await db
    .update(orgValueReservations)
    .set({ status: "settled", updatedAt: new Date() })
    .where(eq(orgValueReservations.id, reservationId));
}

/** Release a reservation (denied or failed); it drops out of the cap SUM. */
export async function releaseReservation(reservationId: string): Promise<void> {
  if (!reservationId) {
    return;
  }
  await db
    .update(orgValueReservations)
    .set({ status: "released", updatedAt: new Date() })
    .where(eq(orgValueReservations.id, reservationId));
}

/**
 * Wrap a value-moving execution so it is charged against the org's daily cap.
 * Reserves `valueWei` before running `run`, then settles on a successful result
 * or releases on a failed result or a thrown error. A zero value skips the cap.
 * Returns the run result, or a cap-exceeded failure without running.
 */
export async function withValueCap<T extends { success: boolean }>(
  params: ReserveParams,
  run: () => Promise<T>
): Promise<T | { success: false; error: string }> {
  if (params.valueWei === "0" || BigInt(params.valueWei) <= BigInt(0)) {
    return await run();
  }

  const reservation = await reserveOrgValue(params);
  if (!reservation.allowed) {
    return { success: false, error: reservation.reason };
  }

  let result: T;
  try {
    result = await run();
  } catch (error) {
    await releaseReservation(reservation.reservationId);
    throw error;
  }

  if (result.success) {
    await settleReservation(reservation.reservationId);
  } else {
    await releaseReservation(reservation.reservationId);
  }
  return result;
}

/**
 * Wrap a Solana value-moving execution so it is charged against the org's
 * daily Solana cap. Mirrors withValueCap for lamports.
 */
export async function withSolanaValueCap<T extends { success: boolean }>(
  params: ReserveSolanaParams,
  run: () => Promise<T>
): Promise<T | { success: false; error: string }> {
  if (
    params.valueLamports === "0" ||
    BigInt(params.valueLamports) <= BigInt(0)
  ) {
    return await run();
  }

  const reservation = await reserveOrgSolanaValue(params);
  if (!reservation.allowed) {
    return { success: false, error: reservation.reason };
  }

  let result: T;
  try {
    result = await run();
  } catch (error) {
    await releaseReservation(reservation.reservationId);
    throw error;
  }

  if (result.success) {
    await settleReservation(reservation.reservationId);
  } else {
    await releaseReservation(reservation.reservationId);
  }
  return result;
}

type StepValueCapArgs = {
  // The workflow's owning org (the credential authority). Absent for
  // org-less workflows -> no org cap applies, so the run is not charged.
  organizationId?: string;
  // Step function name (e.g. transferFundsStep) for chain-aware parsing.
  stepFunction: string;
  // Step config fields used to derive reserved native value.
  config: Record<string, unknown>;
  // Correlation id for audit; the workflow execution id when available.
  executionId?: string;
  source?: string;
  // True when a direct-execution route already reserved this execution's value
  // (see StepContext.valueCapReserved); the step must not reserve again.
  valueCapReserved?: boolean;
};

/**
 * Charge a workflow/protocol step's native value against the org's daily cap.
 * Routes Solana steps to the lamports cap and EVM steps to the wei cap via
 * parseNodeNativeValueWei. Direct-execution API routes reserve via
 * checkAndReserveExecution instead.
 */
export function withStepValueCap<T extends { success: boolean }>(
  args: StepValueCapArgs,
  run: () => Promise<T>
): Promise<T | { success: false; error: string }> {
  if (args.valueCapReserved || !args.organizationId) {
    return run();
  }

  const parsed = parseNodeNativeValueWei(args.stepFunction, args.config);

  if (!parsed.ok) {
    return Promise.resolve({ success: false, error: parsed.error });
  }

  if (parsed.kind === "solana") {
    if (parsed.valueLamports === "0") {
      return run();
    }
    return withSolanaValueCap(
      {
        organizationId: args.organizationId,
        valueLamports: parsed.valueLamports,
        source: args.source ?? "workflow",
        ref: args.executionId,
      },
      run
    );
  }

  if (parsed.valueWei === "0") {
    return run();
  }

  return withValueCap(
    {
      organizationId: args.organizationId,
      valueWei: parsed.valueWei,
      source: args.source ?? "workflow",
      ref: args.executionId,
    },
    run
  );
}
