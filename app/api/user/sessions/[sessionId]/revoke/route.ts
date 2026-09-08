import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type RequestBody = {
  code?: string;
  emailOtp?: string;
  signature?: string;
};

/**
 * POST /api/user/sessions/:sessionId/revoke
 *
 * Deletes a single session row owned by the caller. Used by the
 * Active sessions panel so a user can sign out a specific device
 * (a left-open browser, a session-cookie copy elsewhere, anything
 * they no longer trust) without affecting the device they're
 * currently using.
 *
 * Gated by step-up so a stolen session cookie alone cannot weaponise
 * this endpoint to nuke a user's other devices. The current session
 * cannot be revoked here; the regular sign-out flow handles that and
 * leaves no surprises about how the dialog closes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing session id", code: "missing_session_id" },
      { status: 400 }
    );
  }

  const currentId = (session.session as { id?: string } | undefined)?.id;
  if (currentId && currentId === sessionId) {
    return NextResponse.json(
      {
        error:
          "Use sign-out to end your current session. This endpoint is for revoking other sessions.",
        code: "cannot_revoke_current",
      },
      { status: 400 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;

  const authorized = await authorizeAction({
    session,
    action: STEP_UP_ACTIONS.sessionRevoke,
    roleFloor: "none",
    body,
    headers: request.headers,
  });
  if (!authorized.ok) {
    return authorized.response;
  }

  try {
    const result = await db
      .delete(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, session.user.id))
      )
      .returning({ id: sessions.id });
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Session not found", code: "session_not_found" },
        { status: 404 }
      );
    }
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "session.revoked",
      resourceType: "session",
      resourceId: sessionId,
      metadata: buildAuditMetadata(request),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[sessions.revoke] failed to delete session row",
      err,
      {
        endpoint: "/api/user/sessions/:sessionId/revoke",
        user_id: session.user.id,
        target_session_id: sessionId,
      }
    );
    return NextResponse.json(
      { error: "Failed to revoke session", code: "revoke_failed" },
      { status: 500 }
    );
  }
}
