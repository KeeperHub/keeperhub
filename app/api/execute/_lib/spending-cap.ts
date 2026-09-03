import "server-only";

import { eq } from "drizzle-orm";
import { chargePaygIfBillable } from "@/lib/billing/payg/charge";
import { db } from "@/lib/db";
import { directExecutions } from "@/lib/db/schema";
import {
  getDefaultDailySolanaValueCapLamports,
  getDefaultDailyValueCapWei,
} from "@/lib/execute/spend-cap-defaults";
import {
  lockOrgSpendCapRow,
  sumOrgSolanaValueTodayLamports,
  sumOrgValueTodayWei,
} from "@/lib/execute/value-ledger";
import { logSecurityEvent } from "@/lib/logging";
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
  // The PAYG verdict this request was admitted on, taken from the guard the
  // route ran before anything was written. It cannot be re-derived after the
  // reservation below, because the execution row is committed by then and
  // counts towards the org's monthly usage.
  paygOverflow: boolean;
};

type ReserveResult =
  | { allowed: true; executionId: string }
  | { allowed: false; reason: string };

function defaultCapFor(isSolana: boolean): string {
  return isSolana
    ? getDefaultDailySolanaValueCapLamports()
    : getDefaultDailyValueCapWei();
}

/**
 * Atomically check the daily value cap and create the execution record.
 *
 * The cap bounds the native notional VALUE moved per org per day, not gas.
 * `params.reserved` (known at request time) is charged against the cap for its
 * chain family inside a transaction holding the org's cap row (see
 * lockOrgSpendCapRow, which creates the row when the org has none so that the
 * lock exists), which serializes concurrent requests for the same organization
 * whether or not it ever configured a cap. The execution record is
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
 * When no cap row exists, or the column for that family is null, the platform
 * default for that family applies (see lib/execute/spend-cap-defaults.ts).
 * Unconfigured no longer means unlimited: an organization raises its ceiling by
 * setting one, not by never having set one. An unset Solana cap still does NOT
 * fall back to the wei cap; it falls back to the Solana default.
 */
export async function checkAndReserveExecution(
  params: ReserveExecutionParams
): Promise<ReserveResult> {
  const reserve = await db.transaction(async (tx) => {
    const id = generateId();
    const isSolana = params.reserved.kind === "solana";
    const reserved = BigInt(
      params.reserved.kind === "solana"
        ? params.reserved.valueLamports
        : params.reserved.valueWei
    );

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

    // A request that moves no value cannot push the day's total over anything,
    // so it neither consults the cap nor takes the row lock. Both matter.
    //
    // The comparison below is `total + reserved > dailyCap`, which at reserved
    // = 0 collapses to `total > dailyCap`: once an organization went over for
    // the day, every later zero-value request was refused too -- off-chain node
    // executions and reads that cannot move anything. Before the default
    // existed an unconfigured org returned early and never reached the
    // comparison, so this only became reachable when absent stopped meaning
    // unlimited.
    //
    // Skipping the lock also keeps the insert-and-lock off the request path for
    // the traffic that is mostly zero-value. withValueCap on the ledger side
    // already returns early on a zero value; this matches it.
    if (reserved === BigInt(0)) {
      await insertReservation();
      return { allowed: true, executionId: id } as const;
    }

    const cap = await lockOrgSpendCapRow(tx, params.organizationId);

    const configuredCap = isSolana
      ? cap.dailySolanaValueCapLamports
      : cap.dailyValueCapWei;

    // No cap configured for this chain family (no row, or that column unset)
    // -> the platform default, not unlimited. The two caps stay independent:
    // an unset Solana cap falls back to the Solana default, never to the wei
    // cap.
    const usingDefault = configuredCap === null;
    const effectiveCap = usingDefault ? defaultCapFor(isSolana) : configuredCap;

    // Sum today's value across BOTH stores (direct executions AND the workflow/
    // protocol value ledger) so a direct-API request is charged against value
    // moved by workflow runs too, and cannot exceed the cap by racing them.
    // Runs inside the transaction that holds the cap row, which lockOrgSpendCapRow
    // guarantees exists, so concurrent reservations for this org are serialized
    // whether or not the org ever configured a cap.
    const total = isSolana
      ? await sumOrgSolanaValueTodayLamports(tx, params.organizationId)
      : await sumOrgValueTodayWei(tx, params.organizationId);
    const dailyCap = BigInt(effectiveCap);
    const exceeded = total + reserved > dailyCap;

    // Every value-moving request an unconfigured org makes is reported, so the
    // blast radius of the default is measurable before it starts denying
    // anyone. Zero-value requests returned above and never reach this point.
    if (usingDefault) {
      logSecurityEvent("spend_cap_default_applied", {
        organizationId: params.organizationId,
        surface: "direct-execution",
        chainFamily: isSolana ? "solana" : "evm",
        reason: cap.created ? "no_cap_row" : "cap_unset_for_chain_family",
        defaultCap: effectiveCap,
        reserved: reserved.toString(),
        exceeded,
      });
    }

    // Pre-charge: deny if this request would push the day's total over the cap.
    if (exceeded) {
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
    paygOverflow: params.paygOverflow,
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
