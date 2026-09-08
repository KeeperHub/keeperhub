import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";

/**
 * Org-level incident circuit breaker (self-serve kill switch).
 *
 * A tripped org (`organization.halted_at` set) fails every value-moving
 * workflow/protocol step closed at the value-ledger reservation gate
 * (`reserveOrgValue` / `reserveOrgSolanaValue`) and dispatches no new runs
 * (`workflowReachableConditions`). Read-only steps never reserve value, so they
 * keep running. The switch is reversible: an org admin/owner clears it to resume.
 *
 * `halted_at` is read fresh inside the reservation transaction rather than from a
 * TTL cache. A cached "not halted" would let value keep moving through the very
 * incident window the breaker exists to stop, so the extra indexed primary-key
 * read on an already-heavy (locking transaction + insert) path is the correct
 * trade.
 */

// The denial reason surfaced by the value-ledger reservation gate when the org
// is halted. Distinct from the cap-exceeded reason so callers and logs can tell
// an incident halt from an ordinary spend-cap rejection.
export const ORG_HALTED_REASON =
  "Organization circuit breaker is engaged; value-moving actions are halted";

const RESET_ROLE_RANK: Record<string, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

// biome-ignore lint/suspicious/noExplicitAny: accept either the app db handle or an open transaction, mirroring value-ledger's Executor alias
type Executor = any;

/**
 * Whether the org is currently halted. Takes an executor so the value-ledger can
 * read it inside its reservation transaction, consistent with the row it locks.
 */
export async function isOrgHalted(
  executor: Executor,
  organizationId: string
): Promise<boolean> {
  const [row] = await executor
    .select({ haltedAt: organization.haltedAt })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return (row?.haltedAt ?? null) !== null;
}

export type TripResult = {
  // True when this call engaged the breaker; false when it was already engaged.
  tripped: boolean;
  haltedAt: Date;
};

/**
 * Engage the org's circuit breaker. Idempotent: an org already halted keeps its
 * original reason/actor and timestamp and reports `tripped: false`.
 *
 * Runs under a `SELECT ... FOR UPDATE` so a concurrent reset cannot commit
 * between the read and the write: the decision to trip and the write are one
 * atomic step, so there is no window where an org that exists reads back as
 * "not found". A genuinely missing org (no row) is the only case that throws.
 *
 * Deliberately not role-gated: tripping only PAUSES value movement, is fully
 * reversible, and an org admin/owner can always recover via the admin reset
 * endpoint even while halted. Erring toward letting any workflow stop the
 * bleeding is the fail-safe choice; `haltedBy` records which workflow tripped it
 * for attribution.
 */
export async function tripOrgCircuitBreaker(params: {
  organizationId: string;
  reason?: string | null;
  byWorkflowId?: string | null;
}): Promise<TripResult> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ haltedAt: organization.haltedAt })
      .from(organization)
      .where(eq(organization.id, params.organizationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new Error("Organization not found");
    }
    if (row.haltedAt) {
      return { tripped: false, haltedAt: row.haltedAt };
    }

    const now = new Date();
    await tx
      .update(organization)
      .set({
        haltedAt: now,
        haltedReason: params.reason ?? null,
        haltedBy: params.byWorkflowId ?? null,
      })
      .where(eq(organization.id, params.organizationId));
    return { tripped: true, haltedAt: now };
  });
}

export type ResetResult =
  | { reset: true; wasHalted: boolean }
  | { reset: false; reason: "not_authorized" };

/**
 * Clear the org's circuit breaker. Privileged: succeeds only when the requesting
 * principal is a current admin/owner member of the org. For a workflow-invoked
 * Reset the principal is the workflow creator (audit-only elsewhere, used here
 * purely as the human whose standing role is checked), so a workflow created by
 * a non-admin cannot auto-reset, and a creator later demoted loses the ability -
 * both fail safe. Idempotent: resetting an org that is not halted is a no-op that
 * still reports `reset: true` with `wasHalted: false`.
 */
export async function resetOrgCircuitBreaker(params: {
  organizationId: string;
  requestedByUserId: string | null | undefined;
}): Promise<ResetResult> {
  const userId = params.requestedByUserId;
  if (!userId) {
    return { reset: false, reason: "not_authorized" };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, params.organizationId)
      )
    )
    .limit(1);

  const rank = membership?.role ? (RESET_ROLE_RANK[membership.role] ?? 0) : 0;
  if (rank < RESET_ROLE_RANK.admin) {
    return { reset: false, reason: "not_authorized" };
  }

  const [cleared] = await db
    .update(organization)
    .set({ haltedAt: null, haltedReason: null, haltedBy: null })
    .where(
      and(
        eq(organization.id, params.organizationId),
        isNotNull(organization.haltedAt)
      )
    )
    .returning({ id: organization.id });

  return { reset: true, wasHalted: Boolean(cleared) };
}
