/**
 * Tempo held payments broker.
 *
 * CRUD + guarded status transitions over the `tempo_held_payments` table. A
 * held payment is a Tempo transaction signed now but broadcast later: the row
 * stores the self-contained 0x76 blob and drives when it is released.
 *
 * The single race guard is `claimHeldPayment`: a `WHERE id=? AND status='pending'`
 * UPDATE that flips the row to `broadcasting` and RETURNs it. The manual
 * workflow action, the session endpoint, and the scheduled poller all broadcast
 * only after winning that claim, so a payment can never be broadcast twice (the
 * loser gets `null` and no-ops). This is the same guarded-transition pattern as
 * `resolveApprovalRequest` in lib/agentic-wallet/approval.ts.
 */
import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { type TempoHeldPayment, tempoHeldPayments } from "@/lib/db/schema";
import type { HeldPaymentView } from "@/lib/tempo/held-payment-view";

export type CreateHeldPaymentArgs = {
  organizationId: string;
  createdByUserId?: string;
  workflowId?: string;
  executionId?: string;
  chainId: number;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amountRaw: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountDisplay?: string;
  memo?: string;
  serializedTx: string;
  precomputedHash: string;
  nonceKey: string;
  maxFeePerGas?: string;
  validAfter?: number | null;
  validBefore: number;
  /** Null = manual release. A Date = the scheduled target for the due poller. */
  broadcastAt?: Date | null;
  dispatchKey?: string;
};

export async function createHeldPayment(
  args: CreateHeldPaymentArgs
): Promise<TempoHeldPayment> {
  const rows = await db
    .insert(tempoHeldPayments)
    .values({
      organizationId: args.organizationId,
      createdByUserId: args.createdByUserId,
      workflowId: args.workflowId,
      executionId: args.executionId,
      chainId: args.chainId,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      tokenAddress: args.tokenAddress,
      amountRaw: args.amountRaw,
      tokenSymbol: args.tokenSymbol,
      tokenDecimals: args.tokenDecimals,
      amountDisplay: args.amountDisplay,
      memo: args.memo,
      serializedTx: args.serializedTx,
      precomputedHash: args.precomputedHash,
      nonceKey: args.nonceKey,
      maxFeePerGas: args.maxFeePerGas,
      validAfter: args.validAfter ?? null,
      validBefore: args.validBefore,
      broadcastAt: args.broadcastAt ?? null,
      dispatchKey: args.dispatchKey,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("createHeldPayment: insert returned no row");
  }
  return row;
}

export async function getHeldPayment(
  id: string
): Promise<TempoHeldPayment | null> {
  const rows = await db
    .select()
    .from(tempoHeldPayments)
    .where(eq(tempoHeldPayments.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Org-scoped fetch: returns null when the row is missing OR owned by another
 *  organization, so callers cannot read across tenants. */
export async function getHeldPaymentForOrg(
  id: string,
  organizationId: string
): Promise<TempoHeldPayment | null> {
  const rows = await db
    .select()
    .from(tempoHeldPayments)
    .where(
      and(
        eq(tempoHeldPayments.id, id),
        eq(tempoHeldPayments.organizationId, organizationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export type HeldPaymentListFilter = {
  status?: TempoHeldPayment["status"];
  /** Case-insensitive substring match over memo, addresses, token, hash, id. */
  search?: string;
};

function heldPaymentFilters(
  organizationId: string,
  filter?: HeldPaymentListFilter
): SQL[] {
  const predicates: SQL[] = [
    eq(tempoHeldPayments.organizationId, organizationId),
  ];
  if (filter?.status) {
    predicates.push(eq(tempoHeldPayments.status, filter.status));
  }
  const search = filter?.search?.trim();
  if (search) {
    const like = `%${search}%`;
    const match = or(
      ilike(tempoHeldPayments.memo, like),
      ilike(tempoHeldPayments.toAddress, like),
      ilike(tempoHeldPayments.fromAddress, like),
      ilike(tempoHeldPayments.tokenSymbol, like),
      ilike(tempoHeldPayments.broadcastTxHash, like),
      ilike(tempoHeldPayments.id, like)
    );
    if (match) {
      predicates.push(match);
    }
  }
  return predicates;
}

export async function listHeldPayments(
  organizationId: string,
  opts?: HeldPaymentListFilter & { limit?: number; offset?: number }
): Promise<TempoHeldPayment[]> {
  const rows = await db
    .select()
    .from(tempoHeldPayments)
    .where(and(...heldPaymentFilters(organizationId, opts)))
    .orderBy(desc(tempoHeldPayments.createdAt))
    .limit(opts?.limit ?? 100)
    .offset(opts?.offset ?? 0);
  return rows;
}

export async function countHeldPayments(
  organizationId: string,
  filter?: HeldPaymentListFilter
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tempoHeldPayments)
    .where(and(...heldPaymentFilters(organizationId, filter)));
  return row?.count ?? 0;
}

/**
 * Guarded claim: flip a pending row to `broadcasting` and return it. Returns
 * null when the row is missing, already claimed/terminal, or (when
 * organizationId is passed) owned by another org. The single choke point every
 * broadcast path funnels through, so a double-broadcast is structurally
 * impossible.
 */
export async function claimHeldPayment(
  id: string,
  organizationId?: string
): Promise<TempoHeldPayment | null> {
  const predicates = [
    eq(tempoHeldPayments.id, id),
    eq(tempoHeldPayments.status, "pending"),
  ];
  if (organizationId) {
    predicates.push(eq(tempoHeldPayments.organizationId, organizationId));
  }
  const rows = await db
    .update(tempoHeldPayments)
    .set({
      status: "broadcasting",
      attemptCount: sql`${tempoHeldPayments.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...predicates))
    .returning();
  return rows[0] ?? null;
}

/** Sent to the node but not yet confirmed (poller path): a later reconcile tick
 *  advances the row to `confirmed`. Guarded so it only advances an active row. */
export async function markBroadcast(
  id: string,
  txHash: string
): Promise<TempoHeldPayment | null> {
  const rows = await db
    .update(tempoHeldPayments)
    .set({
      status: "broadcast",
      broadcastTxHash: txHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tempoHeldPayments.id, id),
        eq(tempoHeldPayments.status, "broadcasting")
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function markConfirmed(
  id: string,
  txHash: string
): Promise<TempoHeldPayment | null> {
  const rows = await db
    .update(tempoHeldPayments)
    .set({
      status: "confirmed",
      broadcastTxHash: txHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tempoHeldPayments.id, id),
        inArray(tempoHeldPayments.status, ["broadcasting", "broadcast"])
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function markFailed(
  id: string,
  lastError: string
): Promise<TempoHeldPayment | null> {
  const rows = await db
    .update(tempoHeldPayments)
    .set({ status: "failed", lastError, updatedAt: new Date() })
    .where(
      and(
        eq(tempoHeldPayments.id, id),
        inArray(tempoHeldPayments.status, ["broadcasting", "broadcast"])
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Cancel a payment before it is broadcast. Guarded on `pending`, so a payment
 *  already claimed for broadcast cannot be canceled out from under the sender. */
export async function cancelHeldPayment(
  id: string,
  organizationId: string
): Promise<TempoHeldPayment | null> {
  const rows = await db
    .update(tempoHeldPayments)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(
      and(
        eq(tempoHeldPayments.id, id),
        eq(tempoHeldPayments.organizationId, organizationId),
        eq(tempoHeldPayments.status, "pending")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Mark pending rows whose on-chain window has lapsed as `expired`. Run before
 *  the due selection so a lapsed blob is never broadcast. Returns the count. */
export async function expireDueHeldPayments(): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .update(tempoHeldPayments)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(tempoHeldPayments.status, "pending"),
        lte(tempoHeldPayments.validBefore, nowSec)
      )
    )
    .returning({ id: tempoHeldPayments.id });
  return rows.length;
}

/** Rows sent to the node but not yet reconciled (poller path). A later tick
 *  checks each receipt and advances it to `confirmed` or `failed`. */
export async function selectBroadcastToReconcile(
  limit: number
): Promise<TempoHeldPayment[]> {
  const rows = await db
    .select()
    .from(tempoHeldPayments)
    .where(eq(tempoHeldPayments.status, "broadcast"))
    .orderBy(tempoHeldPayments.updatedAt)
    .limit(limit);
  return rows;
}

/** Scheduled payments whose target time has arrived and whose window is still
 *  open. The poller claims each individually before broadcasting. */
export async function selectDueHeldPayments(
  limit: number
): Promise<TempoHeldPayment[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const now = new Date();
  const rows = await db
    .select()
    .from(tempoHeldPayments)
    .where(
      and(
        eq(tempoHeldPayments.status, "pending"),
        isNotNull(tempoHeldPayments.broadcastAt),
        lte(tempoHeldPayments.broadcastAt, now),
        gt(tempoHeldPayments.validBefore, nowSec)
      )
    )
    .orderBy(tempoHeldPayments.broadcastAt)
    .limit(limit);
  return rows;
}

/** Map a row to the display-safe view (shared type in held-payment-view.ts).
 *  Deliberately omits the signed blob, nonce lane, and fee ceiling (internal
 *  diagnostics), and serializes timestamps to ISO strings. */
export function toHeldPaymentView(row: TempoHeldPayment): HeldPaymentView {
  return {
    id: row.id,
    status: row.status,
    chainId: row.chainId,
    from: row.fromAddress,
    to: row.toAddress,
    tokenAddress: row.tokenAddress,
    tokenSymbol: row.tokenSymbol,
    amount: row.amountDisplay,
    amountRaw: row.amountRaw,
    memo: row.memo,
    precomputedHash: row.precomputedHash,
    broadcastMode: row.broadcastAt ? "schedule" : "manual",
    broadcastAt: row.broadcastAt ? row.broadcastAt.toISOString() : null,
    validAfter: row.validAfter ?? null,
    validBefore: row.validBefore,
    broadcastTxHash: row.broadcastTxHash,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
