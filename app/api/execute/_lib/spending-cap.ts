import "server-only";

import { eq } from "drizzle-orm";
import { chargePaygIfBillable } from "@/lib/billing/payg/charge";
import { db } from "@/lib/db";
import { directExecutions, organizationSpendCaps } from "@/lib/db/schema";
import {
  sumOrgSolanaValueTodayLamports,
  sumOrgValueTodayWei,
} from "@/lib/execute/value-ledger";
import { generateId } from "@/lib/utils/id";

export type SpendCapResult =
  | { allowed: true }
  | { allowed: false; reason: string };

type ReserveExecutionParams = {
  organizationId: string;
  apiKeyId: string;
  type: string;
  network?: string;
  // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
  input: any;
  // Native notional value this execution moves, and which chain family's cap it
  // is charged against. "0" for token-only or no-value calls. EVM amounts are
  // wei and charge dailyValueCapWei; Solana amounts are lamports and charge
  // dailySolanaValueCapLamports. The two caps and their ledger columns are
  // independent - a Solana execution is never charged against the wei cap and
  // vice versa - because wei and lamports are different units and the caps are
  // set in different assets.
  reserved:
    | { kind: "evm"; valueWei: string }
    | { kind: "solana"; valueLamports: string };
};

type ReserveResult =
  | { allowed: true; executionId: string }
  | { allowed: false; reason: string };

/**
 * Atomically check the daily value cap and create the execution record.
 *
 * The cap bounds the native notional VALUE moved per org per day, not gas.
 * `params.reserved` (known at request time) is charged against the cap for its
 * chain family inside a SELECT FOR UPDATE on the cap row, which serializes
 * concurrent requests for the same organization. The execution record is
 * inserted in the same transaction carrying its value, so the reservation is
 * immediately visible to subsequent callers -- closing the TOCTOU that the old
 * gas-based cap had (pending/running rows had null gasUsedWei and contributed 0
 * to the SUM).
 *
 * There are two independent caps, both set by org admins/owners:
 *   EVM    -> dailyValueCapWei             charged in wei      (18 decimals)
 *   Solana -> dailySolanaValueCapLamports  charged in lamports (9 decimals)
 *
 * They are deliberately not one number. An admin sets the wei cap thinking in
 * ETH; folding SOL into it would compare non-commensurable assets against a
 * single figure, and scaling SOL to 18 decimals to fit was only ever a
 * workaround for the missing second cap. Each cap sums only its own ledger
 * column, so neither chain family's activity consumes the other's budget.
 *
 * When no cap row exists, or the column for that family is null, spending of
 * that kind is unlimited. An unset Solana cap does NOT fall back to the wei cap.
 */
export async function checkAndReserveExecution(
  params: ReserveExecutionParams
): Promise<ReserveResult> {
  const reserve = await db.transaction(async (tx) => {
    const caps = await tx
      .select({
        dailyValueCapWei: organizationSpendCaps.dailyValueCapWei,
        dailySolanaValueCapLamports:
          organizationSpendCaps.dailySolanaValueCapLamports,
      })
      .from(organizationSpendCaps)
      .where(eq(organizationSpendCaps.organizationId, params.organizationId))
      .for("update")
      .limit(1);

    const cap = caps[0];
    const id = generateId();
    const isSolana = params.reserved.kind === "solana";

    const insertReservation = () =>
      tx.insert(directExecutions).values({
        id,
        organizationId: params.organizationId,
        apiKeyId: params.apiKeyId,
        type: params.type,
        network: params.network ?? null,
        input: params.input,
        // Exactly one unit column is written per row, so each daily SUM stays
        // single-unit.
        valueWei:
          params.reserved.kind === "evm" ? params.reserved.valueWei : null,
        valueLamports:
          params.reserved.kind === "solana"
            ? params.reserved.valueLamports
            : null,
        status: "pending",
      });

    const configuredCap = isSolana
      ? cap?.dailySolanaValueCapLamports
      : cap?.dailyValueCapWei;

    // No cap configured for this chain family (no row, or that column unset)
    // -> unlimited. The two caps are independent: an unset Solana cap does NOT
    // fall back to the wei cap.
    if (!cap || configuredCap === null || configuredCap === undefined) {
      await insertReservation();
      return { allowed: true, executionId: id } as const;
    }

    // Sum today's value across BOTH stores (direct executions AND the workflow/
    // protocol value ledger) so a direct-API request is charged against value
    // moved by workflow runs too, and cannot exceed the cap by racing them.
    // Runs inside this FOR UPDATE tx, so it is consistent under concurrency.
    const total = isSolana
      ? await sumOrgSolanaValueTodayLamports(tx, params.organizationId)
      : await sumOrgValueTodayWei(tx, params.organizationId);
    const reserved = BigInt(
      params.reserved.kind === "solana"
        ? params.reserved.valueLamports
        : params.reserved.valueWei
    );
    const dailyCap = BigInt(configuredCap);

    // Pre-charge: deny if this request would push the day's total over the cap.
    if (total + reserved > dailyCap) {
      return {
        allowed: false,
        reason: isSolana
          ? "Daily Solana spending cap exceeded"
          : "Daily spending cap exceeded",
      } as const;
    }

    await insertReservation();

    return { allowed: true, executionId: id } as const;
  });

  if (!reserve.allowed) {
    return reserve;
  }

  // PAYG: settle the per-execution price now that the row is reserved, outside
  // the cap transaction so no DB lock is held across the on-chain settlement.
  // The charge is idempotent per (org, executionId). On a cap/funds/payment
  // block, mark the reserved row failed and deny so the route surfaces the
  // reason; non-PAYG orgs pass through untouched.
  const charge = await chargePaygIfBillable({
    organizationId: params.organizationId,
    executionId: reserve.executionId,
  });
  if (charge.applicable && !charge.ok) {
    await db
      .update(directExecutions)
      .set({ status: "failed", error: charge.message, completedAt: new Date() })
      .where(eq(directExecutions.id, reserve.executionId));
    return { allowed: false, reason: charge.message };
  }

  return reserve;
}
