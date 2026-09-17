import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type DisbursementLeg,
  disbursementLegs,
  type TransactionHashEntry,
  workflowExecutions,
} from "@/lib/db/schema";
import { isErrorStatus } from "@/lib/errors/execution-status";
import type { BroadcastEvent } from "@/lib/web3/broadcast-hook";
import { type LegSpec, STALE_CLAIM_MS } from "@/lib/web3/disbursement-plan";
import { validateChainTxHash } from "@/lib/web3/validate-chain-tx-hash";

/**
 * Database side of web3/disburse. Every state change is one statement, and
 * every change a sending run makes is fenced on the claim token it took, so a
 * run that lost its claim can never move a leg.
 */

export type LegKey = {
  organizationId: string;
  runKey: string;
  legIndex: number;
};

function keyWhere(key: LegKey) {
  return and(
    eq(disbursementLegs.organizationId, key.organizationId),
    eq(disbursementLegs.runKey, key.runKey),
    eq(disbursementLegs.legIndex, key.legIndex)
  );
}

export async function readRunLegs(
  organizationId: string,
  runKey: string
): Promise<DisbursementLeg[]> {
  return await db
    .select()
    .from(disbursementLegs)
    .where(
      and(
        eq(disbursementLegs.organizationId, organizationId),
        eq(disbursementLegs.runKey, runKey)
      )
    )
    .orderBy(disbursementLegs.legIndex);
}

/** The receipt record of the executions that last sent these legs. */
export async function readReceiptRecords(
  executionIds: string[]
): Promise<Map<string, TransactionHashEntry[]>> {
  const ids = [...new Set(executionIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      transactionHashes: workflowExecutions.transactionHashes,
    })
    .from(workflowExecutions)
    .where(inArray(workflowExecutions.id, ids));
  const out = new Map<string, TransactionHashEntry[]>();
  for (const row of rows) {
    // Only a finalized run has written its verification. `unconfirmed` is
    // still waiting on the chain, and anything else never broadcast through
    // the finalizer.
    if (row.status === "success" || isErrorStatus(row.status)) {
      out.set(row.id, row.transactionHashes ?? []);
    }
  }
  return out;
}

type Claimer = { executionId?: string; nodeId?: string };

/**
 * Take a leg nobody has recorded yet. Returns the claim token, or null when a
 * concurrent run inserted it first.
 */
export async function claimNewLeg(
  key: LegKey,
  spec: LegSpec,
  by: Claimer
): Promise<string | null> {
  const token = randomUUID();
  const rows = await db
    .insert(disbursementLegs)
    .values({
      organizationId: key.organizationId,
      runKey: key.runKey,
      legIndex: key.legIndex,
      chainId: spec.chainId,
      asset: spec.asset,
      recipient: spec.recipient,
      amount: spec.amount,
      status: "claimed",
      claimToken: token,
      executionId: by.executionId ?? null,
      nodeId: by.nodeId ?? null,
    })
    .onConflictDoNothing()
    .returning({ legIndex: disbursementLegs.legIndex });
  return rows.length > 0 ? token : null;
}

/**
 * Take over a leg that certainly did not pay: `failed`, or a `claimed` row old
 * enough that its run is presumed dead. A `claimed` row never reached the
 * pre-broadcast hook, so it cannot have gone out; a `sending` row is never
 * taken over. Fenced on the token the caller saw, so two runs cannot both win.
 */
export async function reclaimLeg(
  key: LegKey,
  seen: DisbursementLeg,
  by: Claimer
): Promise<string | null> {
  const token = randomUUID();
  const rows = await db
    .update(disbursementLegs)
    .set({
      status: "claimed",
      claimToken: token,
      claimedAt: sql`now()`,
      executionId: by.executionId ?? null,
      nodeId: by.nodeId ?? null,
      transactionHash: null,
      sendTransactionStatusId: null,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        keyWhere(key),
        seen.claimToken === null
          ? isNull(disbursementLegs.claimToken)
          : eq(disbursementLegs.claimToken, seen.claimToken),
        or(
          eq(disbursementLegs.status, "failed"),
          and(
            eq(disbursementLegs.status, "claimed"),
            sql`${disbursementLegs.claimedAt} < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000})`
          )
        )
      )
    )
    .returning({ legIndex: disbursementLegs.legIndex });
  return rows.length > 0 ? token : null;
}

export class LegClaimLostError extends Error {
  constructor(key: LegKey) {
    super(
      `Leg ${key.legIndex} of run ${key.runKey} is no longer held by this run; not sending it`
    );
    this.name = "LegClaimLostError";
  }
}

/**
 * Apply a pre-broadcast event to a held leg. Throws when the write does not
 * land, which aborts the send (see broadcast-hook.ts).
 */
export async function recordBroadcastEvent(
  key: LegKey,
  token: string,
  event: BroadcastEvent
): Promise<void> {
  const held = and(keyWhere(key), eq(disbursementLegs.claimToken, token));
  let rows: unknown[];
  switch (event.kind) {
    case "evm-signed":
    case "solana-signed":
      rows = await db
        .update(disbursementLegs)
        .set({
          status: "sending",
          transactionHash:
            event.kind === "evm-signed"
              ? event.transactionHash
              : event.signature,
          updatedAt: sql`now()`,
        })
        .where(
          and(held, inArray(disbursementLegs.status, ["claimed", "sending"]))
        )
        .returning({ legIndex: disbursementLegs.legIndex });
      break;
    case "sponsored-submitting":
      rows = await db
        .update(disbursementLegs)
        .set({ status: "sending", updatedAt: sql`now()` })
        .where(
          and(held, inArray(disbursementLegs.status, ["claimed", "sending"]))
        )
        .returning({ legIndex: disbursementLegs.legIndex });
      break;
    case "sponsored-accepted":
      rows = await db
        .update(disbursementLegs)
        .set({
          sendTransactionStatusId: event.sendTransactionStatusId,
          updatedAt: sql`now()`,
        })
        .where(and(held, eq(disbursementLegs.status, "sending")))
        .returning({ legIndex: disbursementLegs.legIndex });
      break;
    case "sponsored-not-broadcast":
      // Turnkey reported a definite end before broadcast. With no hash on the
      // leg, it is back to not having been sent.
      rows = await db
        .update(disbursementLegs)
        .set({ status: "claimed", updatedAt: sql`now()` })
        .where(
          and(
            held,
            eq(disbursementLegs.status, "sending"),
            isNull(disbursementLegs.transactionHash)
          )
        )
        .returning({ legIndex: disbursementLegs.legIndex });
      break;
    default:
      rows = [];
  }
  if (rows.length === 0) {
    throw new LegClaimLostError(key);
  }
}

type Outcome =
  | { status: "settled"; transactionHash: string }
  | { status: "failed"; error: string }
  | {
      status: "unknown";
      error: string;
      transactionHash?: string;
      sendTransactionStatusId?: string;
    };

/**
 * Record how the send ended. Best effort by design: if this write fails, the
 * leg stays where the hook left it - `claimed` (never sent) or `sending`
 * (read as unknown by the next run) - which is never a wrong answer.
 */
export async function recordOutcome(
  key: LegKey,
  token: string,
  outcome: Outcome
): Promise<void> {
  const held = and(keyWhere(key), eq(disbursementLegs.claimToken, token));
  if (outcome.status === "settled") {
    await db
      .update(disbursementLegs)
      .set({
        status: "settled",
        transactionHash: outcome.transactionHash,
        lastError: null,
        settledAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(held);
    return;
  }
  if (outcome.status === "failed") {
    // Only a leg that never reached the hook can be failed from a step result.
    await db
      .update(disbursementLegs)
      .set({
        status: "failed",
        lastError: outcome.error,
        updatedAt: sql`now()`,
      })
      .where(and(held, eq(disbursementLegs.status, "claimed")));
    return;
  }
  await db
    .update(disbursementLegs)
    .set({
      status: "unknown",
      lastError: outcome.error,
      ...(outcome.transactionHash
        ? { transactionHash: outcome.transactionHash }
        : {}),
      ...(outcome.sendTransactionStatusId
        ? { sendTransactionStatusId: outcome.sendTransactionStatusId }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(held);
}

/** Settle or fail a leg from the receipt record of the run that sent it. */
export async function applyReceiptVerdict(
  key: LegKey,
  seen: DisbursementLeg,
  verdict: "settled" | "failed"
): Promise<boolean> {
  const rows = await db
    .update(disbursementLegs)
    .set(
      verdict === "settled"
        ? { status: "settled", settledAt: sql`now()`, updatedAt: sql`now()` }
        : {
            status: "failed",
            lastError: "The transaction reverted on chain",
            updatedAt: sql`now()`,
          }
    )
    .where(
      and(
        keyWhere(key),
        inArray(disbursementLegs.status, ["sending", "unknown"]),
        seen.claimToken === null
          ? isNull(disbursementLegs.claimToken)
          : eq(disbursementLegs.claimToken, seen.claimToken),
        seen.transactionHash === null
          ? isNull(disbursementLegs.transactionHash)
          : eq(disbursementLegs.transactionHash, seen.transactionHash)
      )
    )
    .returning({ legIndex: disbursementLegs.legIndex });
  return rows.length > 0;
}

export type ResolveInput = LegKey & {
  outcome: "paid" | "not_paid";
  transactionHash?: string;
  note: string;
  userId: string;
};

export type ResolveResult =
  | { ok: true; leg: DisbursementLeg }
  | {
      ok: false;
      code: "not_found" | "not_resolvable" | "invalid";
      error: string;
    };

/**
 * An operator's answer for a leg that may have paid. Paid needs the
 * transaction that proves it; both outcomes need a note saying what was
 * checked. Only `unknown` legs, and `sending` legs whose run is presumed dead,
 * can be resolved.
 */
export async function resolveLeg(input: ResolveInput): Promise<ResolveResult> {
  const note = input.note.trim();
  if (note === "") {
    return { ok: false, code: "invalid", error: "A note is required" };
  }
  const hash = input.transactionHash?.trim() ?? "";
  if (input.outcome === "paid" && hash === "") {
    return {
      ok: false,
      code: "invalid",
      error:
        "Resolving a leg as paid requires the transaction hash that paid it",
    };
  }
  if (input.outcome === "paid") {
    // The chain a hash is checked against is a fact about the leg, frozen at
    // plan time, not a value the caller supplies - trusting a caller-named
    // chain here would let a well-formed hash from the wrong chain pass as
    // evidence for this one. A leg that does not exist reports not_found
    // here rather than falling through to the update below, which reports
    // the same thing anyway.
    const [target] = await db
      .select({ chainId: disbursementLegs.chainId })
      .from(disbursementLegs)
      .where(keyWhere(input))
      .limit(1);
    if (!target) {
      return { ok: false, code: "not_found", error: "No such leg" };
    }
    if (!validateChainTxHash(hash, target.chainId)) {
      return {
        ok: false,
        code: "invalid",
        error: "Transaction hash is not a valid hash for this leg's chain",
      };
    }
  }
  const resolvable = or(
    eq(disbursementLegs.status, "unknown"),
    and(
      eq(disbursementLegs.status, "sending"),
      sql`${disbursementLegs.updatedAt} < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000})`
    )
  );
  const rows = await db
    .update(disbursementLegs)
    .set(
      input.outcome === "paid"
        ? {
            status: "settled",
            transactionHash: hash,
            settledAt: sql`now()`,
            resolvedBy: input.userId,
            resolutionNote: note,
            resolvedAt: sql`now()`,
            updatedAt: sql`now()`,
          }
        : {
            status: "failed",
            resolvedBy: input.userId,
            resolutionNote: note,
            resolvedAt: sql`now()`,
            lastError: "Resolved as not paid",
            updatedAt: sql`now()`,
          }
    )
    .where(and(keyWhere(input), resolvable))
    .returning();
  if (rows[0]) {
    return { ok: true, leg: rows[0] };
  }
  const existing = await db
    .select({ status: disbursementLegs.status })
    .from(disbursementLegs)
    .where(keyWhere(input))
    .limit(1);
  if (!existing[0]) {
    return { ok: false, code: "not_found", error: "No such leg" };
  }
  return {
    ok: false,
    code: "not_resolvable",
    error:
      existing[0].status === "sending"
        ? "This leg is still being sent; it can be resolved once its run has stopped"
        : `Only a leg that may have paid can be resolved (this one is ${existing[0].status})`,
  };
}
