/**
 * Wallet approval request broker (infra for Phase 34 in-chat ask-decision flow).
 *
 * Three helpers over the `wallet_approval_requests` table:
 *   - createApprovalRequest({ subOrgId, riskLevel: 'ask' | 'block',
 *                              operationPayload }) -> { id }
 *       Inserts a pending row and returns its id. Throws when riskLevel is
 *       'auto' -- auto-tier ops must bypass approval entirely (RESEARCH
 *       Pattern 6 pre-filter).
 *   - getApprovalRequest(id) -> WalletApprovalRequest | null
 *       Selects a single row by id; returns null on miss.
 *   - resolveApprovalRequest(id, userId, decision) -> WalletApprovalRequest | null
 *       Transitions a PENDING row to `decision` and stamps resolvedAt +
 *       resolvedByUserId. Returns the updated row via .returning(), or null
 *       if no row matched (id not found OR already resolved). The
 *       status='pending' predicate guards against the T-33-race-double-approve
 *       race.
 */
import { and, eq } from "drizzle-orm";
import {
  USDC_BASE_ADDRESS,
  USDC_TEMPO_ADDRESS,
} from "@/lib/agentic-wallet/constants";
import { db } from "@/lib/db";
import {
  type WalletApprovalRequest,
  walletApprovalRequests,
} from "@/lib/db/schema";

/**
 * Phase 37 fix B1: Immutable binding for an approval request. The four fields
 * are written into dedicated bound_* columns at create time and re-checked on
 * /approve so a tampered operationPayload cannot resolve into a different
 * recipient, amount, chain, or USDC contract.
 */
export type ApprovalBinding = {
  recipient: string;
  amountMicro: string; // decimal string (USDC micros)
  chain: string;
  contract: string;
};

// Positive-integer decimal string matcher. Hoisted to module scope per
// lint/performance/useTopLevelRegex.
const DECIMAL_DIGITS_RE = /^\d+$/;

/**
 * Single source of truth for deriving the binding fields from a sign/approval
 * request body. `/sign` (ask-tier), `/approval-request`, and Task 13's
 * `checkApprovalForResolve` all funnel through this helper so that binding
 * creation and binding re-derivation cannot drift apart.
 *
 * Returns `null` whenever the binding cannot be derived — callers map that
 * to a 422 BINDING_REQUIRED response. The helper intentionally does NOT
 * throw; callers are expected to decide the status code.
 *
 * Rules (matches Task 13 checkApprovalForResolve re-derivation):
 *   - chain must be "base" or "tempo" (case-sensitive)
 *   - challenge must be a non-null, non-array object
 *   - recipient:
 *       base  -> String(challenge.payTo)
 *       tempo -> String(challenge.payTo ?? challenge.recipient)
 *     Empty string after coercion rejects.
 *   - amountMicro: String(challenge.amount) must be a non-empty
 *     decimal-digit string parseable to a BigInt greater than zero.
 *     Mirrors lib/agentic-wallet/workflow-binding.ts's BigInt parse idiom.
 *   - contract: picked from USDC constants by chain.
 */
export function deriveApprovalBinding(
  chain: unknown,
  challenge: unknown
): ApprovalBinding | null {
  if (chain !== "base" && chain !== "tempo") {
    return null;
  }
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
    return null;
  }
  const challengeFields = challenge as Record<string, unknown>;

  const recipient =
    chain === "base"
      ? String(challengeFields.payTo ?? "")
      : String(challengeFields.payTo ?? challengeFields.recipient ?? "");
  if (!recipient) {
    return null;
  }

  const rawAmount = challengeFields.amount;
  if (rawAmount === undefined || rawAmount === null) {
    return null;
  }
  const amountMicro = String(rawAmount);
  // Require a non-empty decimal-digit string. Rejects "", "0.0", "-5", "abc",
  // whitespace, etc. BigInt("00") === 0 which falls through to the positive-
  // amount guard below, so "00" is rejected as zero rather than as malformed.
  if (!DECIMAL_DIGITS_RE.test(amountMicro)) {
    return null;
  }
  if (BigInt(amountMicro) <= BigInt(0)) {
    return null;
  }

  const contract = chain === "base" ? USDC_BASE_ADDRESS : USDC_TEMPO_ADDRESS;
  return { recipient, amountMicro, chain, contract };
}

export type CreateApprovalRequestArgs = {
  subOrgId: string;
  riskLevel: "ask" | "block";
  operationPayload: Record<string, unknown>;
  binding: ApprovalBinding;
};

export async function createApprovalRequest(
  args: CreateApprovalRequestArgs
): Promise<{ id: string }> {
  // Defensive guard: even though the TS type excludes "auto", callers may
  // ignore the hint. Phase 34's pre-filter should never reach this call-site
  // with auto-tier ops, so throwing is the safest failure mode.
  if ((args.riskLevel as string) === "auto") {
    throw new Error(
      "createApprovalRequest: riskLevel 'auto' must not create a row"
    );
  }

  const rows = await db
    .insert(walletApprovalRequests)
    .values({
      subOrgId: args.subOrgId,
      riskLevel: args.riskLevel,
      operationPayload: args.operationPayload,
      boundRecipient: args.binding.recipient,
      boundAmountMicro: args.binding.amountMicro,
      boundChain: args.binding.chain,
      boundContract: args.binding.contract,
    })
    .returning({ id: walletApprovalRequests.id });

  const row = rows?.[0];
  if (!row) {
    throw new Error("createApprovalRequest: insert returned no row");
  }
  return { id: row.id };
}

export async function getApprovalRequest(
  id: string
): Promise<WalletApprovalRequest | null> {
  const rows = await db
    .select()
    .from(walletApprovalRequests)
    .where(eq(walletApprovalRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveApprovalRequest(
  id: string,
  userId: string,
  decision: "approved" | "rejected"
): Promise<WalletApprovalRequest | null> {
  const rows = await db
    .update(walletApprovalRequests)
    .set({
      status: decision,
      resolvedAt: new Date(),
      resolvedByUserId: userId,
    })
    .where(
      and(
        eq(walletApprovalRequests.id, id),
        eq(walletApprovalRequests.status, "pending")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Phase 37 fix B2: unified gate guarding /approve and /reject against:
 *   - `not-found`         -> 404, row id unknown
 *   - `already-resolved`  -> 409, row status is not "pending"
 *   - `expired`           -> 410 GONE, expiresAt has passed; lazy-flip the row
 *                            to status="expired" so the cron sweeper is not
 *                            the only path that marks the row terminal
 *   - `binding-mismatch`  -> 422, operationPayload's re-derived
 *                            recipient/amount/chain/contract diverges from the
 *                            stored bound_* columns (payload was tampered with
 *                            after create)
 *
 * Binding re-derivation funnels through `deriveApprovalBinding` so the same
 * rules apply at /sign, at /approval-request, and here. A `null` result from
 * the helper is also classed as `binding-mismatch` -- the payload can no
 * longer be turned into a valid binding, therefore it cannot match what the
 * row committed to at create time.
 */
export type ApprovalCheckResult =
  | { ok: true; row: WalletApprovalRequest }
  | {
      ok: false;
      reason: "not-found" | "expired" | "binding-mismatch" | "already-resolved";
    };

export async function checkApprovalForResolve(
  id: string
): Promise<ApprovalCheckResult> {
  const row = await getApprovalRequest(id);
  if (!row) {
    return { ok: false, reason: "not-found" };
  }
  if (row.status !== "pending") {
    return { ok: false, reason: "already-resolved" };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    // Lazy-flip to "expired" so callers see a terminal row immediately; the
    // cron sweeper can still catch rows that never get polled. The
    // status='pending' guard in the WHERE clause prevents a TOCTOU race where
    // a slow /approve call reads the row as pending, another caller resolves
    // it to 'approved' first, then this unguarded UPDATE would silently
    // overwrite the terminal status. With the guard, concurrent writers
    // either both match (first lands, second no-ops) or the expired flip
    // no-ops once the row is already terminal.
    await db
      .update(walletApprovalRequests)
      .set({ status: "expired", resolvedAt: new Date() })
      .where(
        and(
          eq(walletApprovalRequests.id, id),
          eq(walletApprovalRequests.status, "pending")
        )
      );
    return { ok: false, reason: "expired" };
  }

  const op = row.operationPayload as Record<string, unknown>;
  const challenge = op?.paymentChallenge;
  const current = deriveApprovalBinding(op?.chain, challenge);
  if (!current) {
    return { ok: false, reason: "binding-mismatch" };
  }
  if (
    current.recipient !== row.boundRecipient ||
    current.amountMicro !== row.boundAmountMicro ||
    current.chain !== row.boundChain ||
    current.contract !== row.boundContract
  ) {
    return { ok: false, reason: "binding-mismatch" };
  }

  return { ok: true, row };
}
