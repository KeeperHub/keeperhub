import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { policyLimitReservations, policyLimitUsage } from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import {
  FactState,
  PolicyLimitMetric,
  PolicyLimitScope,
  type PolicyLimitWindow,
} from "@/lib/policy/constants";
import { principalId } from "@/lib/policy/principal-facts";
import type { PolicyFacts, PolicyLimit, Principal } from "@/lib/policy/types";

/** How long a reservation nothing settles or releases is held before sweeping. */
const RESERVATION_TTL_MS = 900_000;

const WINDOW_MS: Record<PolicyLimitWindow, number> = {
  "1h": 3_600_000,
  "1d": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};

/**
 * The start of the window a moment falls in.
 *
 * Fixed windows rather than rolling ones, so the counter is a row that can be
 * incremented atomically. A rolling window would need every past action summed
 * on each decision, which is both slower and racy.
 */
export function windowStart(window: PolicyLimitWindow, now: Date): Date {
  const size = WINDOW_MS[window];
  return new Date(Math.floor(now.getTime() / size) * size);
}

function knownValue<T>(fact: { state: string; value?: unknown }): T | null {
  return fact.state === FactState.KNOWN ? ((fact.value as T) ?? null) : null;
}

/**
 * What one limit counts for this action.
 *
 * Null when the action carries nothing that limit measures: a dollar limit on
 * an action with no readable value charges nothing rather than charging zero,
 * because zero would silently pass a cap the action should have been checked
 * against.
 */
export function amountFor(
  limit: PolicyLimit,
  facts: PolicyFacts
): string | null {
  if (limit.metric === PolicyLimitMetric.COUNT) {
    return "1";
  }
  if (limit.metric === PolicyLimitMetric.USD) {
    return knownValue<string>(facts.usdValue);
  }
  // A token limit counts the named asset's own units.
  const assets = knownValue<{ address?: string; amount?: string }[]>(
    facts.assets
  );
  // Both sides are lowered before comparing. The address on the fact arrives in
  // whatever case the chain or the ABI produced, usually checksummed, so
  // lowering only the policy's side meant a checksummed address never matched:
  // the amount came back null and the caller skipped the limit entirely, which
  // is the silent pass this function exists to avoid. `includes` stays so the
  // limit can name the asset by its identifier as well as by a bare address.
  const wanted = limit.asset?.toLowerCase();
  const match = assets?.find((asset) => {
    const address = asset.address?.toLowerCase();
    return Boolean(
      address && wanted && (wanted === address || wanted.includes(address))
    );
  });
  return match?.amount ?? null;
}

export type ReservationHandle = {
  reservationId: string;
  sid: string;
};

export type ReserveOutcome =
  | { ok: true; reservations: ReservationHandle[] }
  | { ok: false; sid: string };

function scopeKeyFor(
  limit: PolicyLimit,
  facts: PolicyFacts,
  principal?: Principal
): string {
  if (limit.scope === PolicyLimitScope.WORKFLOW) {
    return knownValue<string>(facts.workflowId) ?? "unknown-workflow";
  }
  if (limit.scope === PolicyLimitScope.PRINCIPAL) {
    // Without this the scope fell through to the organization bucket, so "each
    // person gets their own daily budget" was one budget everybody drew from
    // and the first spender could exhaust it for the rest.
    const id = principal ? principalId(principal) : null;
    return id ? `principal:${id}` : "unknown-principal";
  }
  return "organization";
}

/**
 * Take headroom out of a limit, or report that there is none.
 *
 * The increment is conditional and atomic: the update only applies when the new
 * total still fits, so two actions racing for the last of a budget cannot both
 * read the same headroom and both proceed. Checking first and writing second
 * would let both through and discover the overspend afterwards.
 */
async function reserveOne(input: {
  organizationId: string;
  policyId: string;
  sid: string;
  limit: PolicyLimit;
  amount: string;
  now: Date;
  scopeKey: string;
}): Promise<string | null> {
  const start = windowStart(input.limit.window, input.now);

  const [row] = await db
    .insert(policyLimitUsage)
    .values({
      organizationId: input.organizationId,
      policyId: input.policyId,
      sid: input.sid,
      metric: input.limit.metric,
      window: input.limit.window,
      windowStart: start,
      scopeKey: input.scopeKey,
      used: input.amount,
    })
    .onConflictDoUpdate({
      target: [
        policyLimitUsage.policyId,
        policyLimitUsage.sid,
        policyLimitUsage.metric,
        policyLimitUsage.window,
        policyLimitUsage.windowStart,
        policyLimitUsage.scopeKey,
      ],
      set: {
        used: sql`${policyLimitUsage.used} + ${input.amount}::numeric`,
        updatedAt: new Date(),
      },
      setWhere: sql`${policyLimitUsage.used} + ${input.amount}::numeric <= ${input.limit.max}::numeric`,
    })
    .returning({ id: policyLimitUsage.id });

  if (!row) {
    // The conditional update did not apply, so the window has no headroom.
    return null;
  }

  const [reservation] = await db
    .insert(policyLimitReservations)
    .values({
      usageId: row.id,
      amount: input.amount,
      expiresAt: new Date(input.now.getTime() + RESERVATION_TTL_MS),
    })
    .returning({ id: policyLimitReservations.id });

  return reservation?.id ?? null;
}

/**
 * Reserve every limit attached to the statements that permitted an action.
 *
 * All or nothing: a limit that cannot be taken releases the ones already taken,
 * so a refused action leaves no budget consumed.
 */
export async function reserveLimits(input: {
  organizationId: string;
  limits: { policyId: string; sid: string; limit: PolicyLimit }[];
  facts: PolicyFacts;
  /** Required for a principal-scoped limit to get its own bucket. */
  principal?: Principal;
  now?: Date;
}): Promise<ReserveOutcome> {
  const now = input.now ?? new Date();
  const taken: ReservationHandle[] = [];

  for (const entry of input.limits) {
    const amount = amountFor(entry.limit, input.facts);
    if (amount === null) {
      continue;
    }
    const reservationId = await reserveOne({
      organizationId: input.organizationId,
      policyId: entry.policyId,
      sid: entry.sid,
      limit: entry.limit,
      amount,
      now,
      scopeKey: scopeKeyFor(entry.limit, input.facts, input.principal),
    });

    if (!reservationId) {
      await releaseReservations(taken);
      return { ok: false, sid: entry.sid };
    }
    taken.push({ reservationId, sid: entry.sid });
  }

  return { ok: true, reservations: taken };
}

/** Permanently consume the reservations an action held. */
export async function settleReservations(
  handles: readonly ReservationHandle[]
): Promise<void> {
  await Promise.all(
    handles.map((handle) =>
      db
        .update(policyLimitReservations)
        .set({ status: "settled" })
        .where(eq(policyLimitReservations.id, handle.reservationId))
    )
  );
}

/**
 * Give back the budget an action reserved but did not use.
 *
 * A failed transaction must not permanently consume a spend limit, or a run of
 * failures would exhaust a budget nothing was ever spent from.
 */
export async function releaseReservations(
  handles: readonly ReservationHandle[]
): Promise<void> {
  for (const handle of handles) {
    try {
      const [row] = await db
        .update(policyLimitReservations)
        .set({ status: "released" })
        .where(
          and(
            eq(policyLimitReservations.id, handle.reservationId),
            eq(policyLimitReservations.status, "reserved")
          )
        )
        .returning({
          usageId: policyLimitReservations.usageId,
          amount: policyLimitReservations.amount,
        });

      if (!row) {
        continue;
      }

      await db
        .update(policyLimitUsage)
        .set({
          used: sql`GREATEST(${policyLimitUsage.used} - ${row.amount}::numeric, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(policyLimitUsage.id, row.usageId));
    } catch (error) {
      // A reservation that cannot be released expires on its own, so the budget
      // is returned late rather than lost. Failing the action here would turn a
      // bookkeeping problem into a refused transaction.
      logSystemWarn(
        ErrorCategory.DATABASE,
        "[PolicyLimits] Could not release a reservation",
        error,
        { reservationId: handle.reservationId }
      );
    }
  }
}
