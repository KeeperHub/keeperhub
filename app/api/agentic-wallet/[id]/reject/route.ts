/**
 * POST /api/agentic-wallet/:id/reject
 *
 * Session-authenticated rejection of a pending wallet approval request.
 * Identical lifecycle to /:id/approve (same ownership rule, same 409
 * ALREADY_RESOLVED, same 410 EXPIRED, same 422 BINDING_MISMATCH) except the
 * terminal status is "rejected".
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
    action: STEP_UP_ACTIONS.agenticWalletReject,
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

    const resolved = await resolveApprovalRequest(id, userId, "rejected");
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
      action: "agentic_wallet.approval_denied",
      resourceType: "agentic_wallet",
      resourceId: id,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ ok: true, status: "rejected" });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Agentic] /reject failed", error, {
      endpoint: `/api/agentic-wallet/${id}/reject`,
      userId,
    });
    return NextResponse.json({ error: "Reject failed" }, { status: 500 });
  }
}
