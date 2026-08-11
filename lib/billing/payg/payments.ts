import "server-only";

import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { type NewPaygPayment, paygPayments } from "@/lib/db/schema-extensions";
import { PAYG_PAYMENT_STATUS } from "./constants";

export type PaygPaymentRow = {
  executionId: string;
  amountRaw: string;
  txHash: string | null;
  chainId: number;
  createdAt: Date;
  workflowId: string | null;
  workflowName: string | null;
};

/**
 * Claim an execution for charging by inserting its payment row as `pending`.
 * Returns true when this call created the row (the caller owns the settlement)
 * and false when a row for (org, execution) already exists, so a concurrent
 * caller backs off instead of settling a second on-chain transfer. The pending
 * row also reserves its amount against the spend caps until it settles or is
 * released.
 */
export async function claimPaygPayment(
  payment: NewPaygPayment
): Promise<boolean> {
  const rows = await db
    .insert(paygPayments)
    .values(payment)
    .onConflictDoNothing()
    .returning({ id: paygPayments.id });
  return rows.length > 0;
}

/** Flip a claimed row from `pending` to `settled` with its on-chain tx hash. */
export async function markPaygPaymentSettled(
  organizationId: string,
  executionId: string,
  txHash: string
): Promise<void> {
  await db
    .update(paygPayments)
    .set({ status: PAYG_PAYMENT_STATUS.settled, txHash })
    .where(
      and(
        eq(paygPayments.organizationId, organizationId),
        eq(paygPayments.executionId, executionId)
      )
    );
}

/**
 * Release a claim whose settlement did not complete, freeing the (org,
 * execution) idempotency slot and its reserved cap amount for a later retry.
 * Only deletes a `pending` row, never a settled one.
 */
export async function releasePaygClaim(
  organizationId: string,
  executionId: string
): Promise<void> {
  await db
    .delete(paygPayments)
    .where(
      and(
        eq(paygPayments.organizationId, organizationId),
        eq(paygPayments.executionId, executionId),
        eq(paygPayments.status, PAYG_PAYMENT_STATUS.pending)
      )
    );
}

/**
 * The recorded payment for one execution, or null, with its status so callers
 * can tell a settled charge (return its tx) from a pending claim (another
 * attempt owns it) and keep charging idempotent.
 */
export async function findPaygPayment(
  organizationId: string,
  executionId: string
): Promise<{
  txHash: string | null;
  amountRaw: string;
  status: string;
} | null> {
  const rows = await db
    .select({
      txHash: paygPayments.txHash,
      amountRaw: paygPayments.amountRaw,
      status: paygPayments.status,
    })
    .from(paygPayments)
    .where(
      and(
        eq(paygPayments.organizationId, organizationId),
        eq(paygPayments.executionId, executionId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * SUM of USDC (raw) charged in [since, until) for an org. Counts settled rows
 * only by default; pass includePending to also count in-flight claims, which
 * the cap checks use so concurrent claims reserve against one another.
 */
export async function getPaygSpentRaw(
  organizationId: string,
  since: Date,
  until?: Date,
  opts?: { includePending?: boolean }
): Promise<bigint> {
  const upperBound = until
    ? sql`AND created_at < ${until.toISOString()}`
    : sql``;
  const statusFilter = opts?.includePending
    ? sql`AND status IN (${PAYG_PAYMENT_STATUS.settled}, ${PAYG_PAYMENT_STATUS.pending})`
    : sql`AND status = ${PAYG_PAYMENT_STATUS.settled}`;
  const rows = await db.execute<{ spent: string }>(sql`
    SELECT COALESCE(SUM(amount_raw::numeric), 0)::text AS spent
    FROM payg_payments
    WHERE organization_id = ${organizationId}
      ${statusFilter}
      AND created_at >= ${since.toISOString()}
      ${upperBound}
  `);
  return BigInt(rows[0]?.spent ?? "0");
}

/**
 * One page of an org's PAYG charges, newest first, joined to the workflow
 * execution that triggered each charge. workflowId/workflowName are null when
 * the charge's execution id is not a workflow run (direct-API charges). Returns
 * the slice plus the total row count for server-side pagination.
 */
export async function listPaygPaymentsPage(
  organizationId: string,
  opts: { limit: number; offset: number; search?: string }
): Promise<{ items: PaygPaymentRow[]; total: number }> {
  const term = opts.search?.trim();
  const like = term ? `%${term}%` : null;
  // Free-text search across the charge (execution id, tx hash) and its workflow
  // (id, name). Case-insensitive substring match.
  const searchFilter = like
    ? or(
        ilike(paygPayments.executionId, like),
        ilike(paygPayments.txHash, like),
        ilike(workflowExecutions.workflowId, like),
        ilike(workflows.name, like)
      )
    : undefined;
  // Only settled charges: an in-flight or stuck `pending` claim is not a
  // completed charge and must not surface in the history as a tx-less row.
  const where = and(
    eq(paygPayments.organizationId, organizationId),
    eq(paygPayments.status, PAYG_PAYMENT_STATUS.settled),
    searchFilter
  );

  // The count only needs the workflow joins when the search filters on them;
  // without a search it stays an index-only scan on (organization_id, created_at).
  const countQuery = like
    ? db
        .select({ total: count() })
        .from(paygPayments)
        .leftJoin(
          workflowExecutions,
          eq(workflowExecutions.id, paygPayments.executionId)
        )
        .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
        .where(where)
    : db.select({ total: count() }).from(paygPayments).where(where);

  const [items, totals] = await Promise.all([
    db
      .select({
        executionId: paygPayments.executionId,
        amountRaw: paygPayments.amountRaw,
        txHash: paygPayments.txHash,
        chainId: paygPayments.chainId,
        createdAt: paygPayments.createdAt,
        workflowId: workflowExecutions.workflowId,
        workflowName: workflows.name,
      })
      .from(paygPayments)
      .leftJoin(
        workflowExecutions,
        eq(workflowExecutions.id, paygPayments.executionId)
      )
      .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .where(where)
      .orderBy(desc(paygPayments.createdAt))
      .limit(opts.limit)
      .offset(opts.offset),
    countQuery,
  ]);
  return { items, total: totals[0]?.total ?? 0 };
}

/** Executions charged and total USDC (raw) in [since, until) -- for reporting. */
export async function getPaygUsage(
  organizationId: string,
  since: Date,
  until?: Date
): Promise<{ executions: number; spentRaw: bigint }> {
  const upperBound = until
    ? sql`AND created_at < ${until.toISOString()}`
    : sql``;
  const rows = await db.execute<{ executions: number; spent: string }>(sql`
    SELECT COUNT(*)::int AS executions,
           COALESCE(SUM(amount_raw::numeric), 0)::text AS spent
    FROM payg_payments
    WHERE organization_id = ${organizationId}
      AND status = ${PAYG_PAYMENT_STATUS.settled}
      AND created_at >= ${since.toISOString()}
      ${upperBound}
  `);
  return {
    executions: rows[0]?.executions ?? 0,
    spentRaw: BigInt(rows[0]?.spent ?? "0"),
  };
}
