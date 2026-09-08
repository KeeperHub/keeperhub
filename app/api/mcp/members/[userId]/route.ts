import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  exceedsCeiling,
  getMemberScopeCeiling,
  getOrgMaxScope,
  isSupportedScope,
  setMemberScopeCeiling,
} from "@/lib/mcp/connections";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { resolveCaller, roleOf } from "../../connections/_lib/guard";

type Params = { params: Promise<{ userId: string }> };

/**
 * PATCH /api/mcp/members/{userId}
 *
 * The most this person's agents may do in this organization.
 *
 * Keyed by the person rather than by a session, for two reasons: every `mcp add`
 * registers a new client, so a limit held against a session is shed by
 * reconnecting; and somebody who has never connected an agent has no session to
 * key on, yet is exactly who an admin wants to limit in advance.
 *
 * Sessions are left alone. What one was granted is a record of what was
 * approved, and the limit is applied on every call instead, so lowering it binds
 * at once without ending anything or rewriting what was chosen.
 */
export async function PATCH(
  request: Request,
  context: Params
): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }
  if (!caller.isAdmin) {
    return NextResponse.json(
      { error: "Only organization admins and owners can change this" },
      { status: 403 }
    );
  }

  try {
    const { userId } = await context.params;
    const body = (await request.json()) as { scope?: unknown };
    if (!isSupportedScope(body.scope)) {
      return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
    }

    const targetRole = await roleOf(userId, caller.organizationId);
    if (!targetRole) {
      return NextResponse.json(
        { error: "Not a member of this organization" },
        { status: 404 }
      );
    }
    // An admin does not outrank an owner, so only an owner may set an owner's
    // limit, which in practice means their own.
    if (targetRole === "owner" && caller.role !== "owner") {
      return NextResponse.json(
        { error: "Only an owner can change an owner's access" },
        { status: 403 }
      );
    }

    const ceiling = await getOrgMaxScope(caller.organizationId);
    if (exceedsCeiling(body.scope, ceiling)) {
      return NextResponse.json(
        { error: `This organization allows at most ${ceiling}` },
        { status: 403 }
      );
    }

    const before = await getMemberScopeCeiling(userId, caller.organizationId);
    await setMemberScopeCeiling(userId, caller.organizationId, body.scope);

    await recordAuditEvent({
      action: "mcp_member_scope.changed",
      actor: {
        apiKeyId: caller.apiKeyId ?? null,
        authMethod: caller.authMethod,
        organizationId: caller.organizationId,
        userId: caller.userId,
      },
      after: { scope: body.scope },
      before: { scope: before },
      metadata: { ...buildAuditMetadata(request), subjectUserId: userId },
      resourceId: userId,
      resourceType: "mcp_member_scope",
    });

    return NextResponse.json({ scope: body.scope, success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpMembers] Failed to change a member's agent access",
      error,
      { endpoint: "/api/mcp/members/[userId]", operation: "patch" }
    );
    return NextResponse.json(
      { error: "Could not change the access" },
      { status: 500 }
    );
  }
}
