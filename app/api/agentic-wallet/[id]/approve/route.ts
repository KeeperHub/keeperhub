/**
 * POST /api/agentic-wallet/:id/approve
 *
 * Session-authenticated approval of a pending wallet approval request. The
 * logged-in user must OWN the underlying agentic wallet -- i.e. the wallet's
 * linked_user_id must equal session.user.id. Unlinked wallets are forbidden
 * (RESEARCH Anti-Patterns line 576-577: "no approver exists").
 *
 * Lifecycle:
 *   1. 401 when there is no session.
 *   2. 404 when the approval request id is unknown.
 *   3. 410 { code: "EXPIRED" } when expiresAt has passed -- the helper also
 *      lazy-flips the row to status="expired" (guarded by status='pending').
 *   4. 422 { code: "BINDING_MISMATCH" } when operationPayload has been
 *      tampered after create and its re-derived binding no longer matches the
 *      stored bound_* columns (recipient / amount / chain / contract).
 *   5. 404 when the wallet for row.subOrgId does not exist.
 *   6. 403 when the wallet exists but linked_user_id != session.user.id
 *      (covers unlinked wallets).
 *   7. 409 { code: "ALREADY_RESOLVED" } when the row is not pending OR when
 *      resolveApprovalRequest returns null -- another approver (or a
 *      duplicate tab) already resolved the row (T-33-race-double-approve).
 *   8. 200 { ok: true, status: "approved" } on success.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  checkApprovalForResolve,
  resolveApprovalRequest,
} from "@/lib/agentic-wallet/approval";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { agenticWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

type OwnerCheckResult = "ok" | "not-found" | "forbidden";

async function ownerCheck(
  subOrgId: string,
  userId: string
): Promise<OwnerCheckResult> {
  const rows = await db
    .select({ linkedUserId: agenticWallets.linkedUserId })
    .from(agenticWallets)
    .where(eq(agenticWallets.subOrgId, subOrgId))
    .limit(1);
  if (rows.length === 0) {
    return "not-found";
  }
  // Unlinked wallets (linkedUserId === null) are never "owned" by a user, so
  // null !== userId always falls through to "forbidden". That matches the
  // RESEARCH directive that unlinked wallets have no approver.
  if (rows[0]?.linkedUserId !== userId) {
    return "forbidden";
  }
  return "ok";
}

export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    code?: string;
    emailOtp?: string;
    signature?: string;
  };
  const authorized = await authorizeAction({
    session,
    action: STEP_UP_ACTIONS.agenticWalletApprove,
    roleFloor: "none",
    body,
    headers: request.headers,
  });
  if (!authorized.ok) {
    return authorized.response;
  }

  const { id } = await params;
  const userId = session.user.id;

  try {
    const check = await checkApprovalForResolve(id);
    if (!check.ok) {
      if (check.reason === "not-found") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      if (check.reason === "expired") {
        return NextResponse.json(
          { error: "Approval request expired", code: "EXPIRED" },
          { status: 410 }
        );
      }
      if (check.reason === "binding-mismatch") {
        return NextResponse.json(
          {
            error: "Approval payload no longer matches the stored binding",
            code: "BINDING_MISMATCH",
          },
          { status: 422 }
        );
      }
      // already-resolved
      return NextResponse.json(
        { error: "Already resolved", code: "ALREADY_RESOLVED" },
        { status: 409 }
      );
    }

    const row = check.row;
    const owner = await ownerCheck(row.subOrgId, userId);
    if (owner === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (owner === "forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const resolved = await resolveApprovalRequest(id, userId, "approved");
    if (!resolved) {
      return NextResponse.json(
        { error: "Already resolved", code: "ALREADY_RESOLVED" },
        { status: 409 }
      );
    }
    await recordAuditEvent({
      actor: {
        userId,
        organizationId: null,
        authMethod: "session",
      },
      action: "agentic_wallet.approval_granted",
      resourceType: "agentic_wallet",
      resourceId: id,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ ok: true, status: "approved" });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Agentic] /approve failed", error, {
      endpoint: `/api/agentic-wallet/${id}/approve`,
      userId,
    });
    return NextResponse.json({ error: "Approve failed" }, { status: 500 });
  }
}
