import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hashSessionToken } from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import { mcpOauthRefreshTokens, member, sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type LeaveRequestBody = {
  /**
   * Required when caller is the sole owner: member id to promote to owner.
   * Must be an accepted member (row in member table), not a pending invitation.
   */
  newOwnerMemberId?: string;
};

type LeaveError =
  | "NOT_MEMBER"
  | "NEW_OWNER_REQUIRED"
  | "NEW_OWNER_NOT_ACCEPTED_MEMBER"
  | "NEW_OWNER_SAME_AS_CURRENT";

type LeaveResult =
  | { success: true; ownershipTransferredTo?: string }
  | { success: false; error: LeaveError };

/**
 * POST /api/organizations/:organizationId/leave
 *
 * Leave the organization. When the caller is the sole owner, newOwnerMemberId
 * must be provided and must refer to an accepted member (in member table).
 * Ownership is transferred and membership removed in a single transaction.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
) {
  try {
    const { organizationId } = await context.params;

    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as LeaveRequestBody;
    const newOwnerMemberId =
      typeof body.newOwnerMemberId === "string"
        ? body.newOwnerMemberId.trim()
        : "";

    // KEEP-239: better-auth's adapter wrapper rewrites session.token back to
    // the raw cookie/bearer value before returning it from getSession. The
    // column itself holds sha256(token), so any direct drizzle query against
    // sessions.token must hash first.
    const sessionToken = session.session?.token;
    if (!sessionToken) {
      return NextResponse.json(
        { error: "Session token not found" },
        { status: 401 }
      );
    }

    const result = await db.transaction(async (tx): Promise<LeaveResult> => {
      const [currentMember] = await tx
        .select({ id: member.id, role: member.role })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, session.user.id)
          )
        )
        .limit(1);

      if (!currentMember) {
        return { success: false, error: "NOT_MEMBER" };
      }

      const ownerCount = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.role, "owner")
          )
        );

      const isOnlyOwner =
        currentMember.role === "owner" && ownerCount.length === 1;

      if (isOnlyOwner) {
        if (!newOwnerMemberId) {
          return { success: false, error: "NEW_OWNER_REQUIRED" };
        }

        const [newOwner] = await tx
          .select({ id: member.id })
          .from(member)
          .where(
            and(
              eq(member.id, newOwnerMemberId),
              eq(member.organizationId, organizationId)
            )
          )
          .limit(1);

        if (!newOwner) {
          return { success: false, error: "NEW_OWNER_NOT_ACCEPTED_MEMBER" };
        }

        if (newOwner.id === currentMember.id) {
          return { success: false, error: "NEW_OWNER_SAME_AS_CURRENT" };
        }

        // Delete the outgoing owner first, then promote the incoming one.
        // The DB enforces at most one owner per org via a partial unique index
        // on member(organization_id) WHERE role = 'owner'. Promoting before
        // deleting would transiently create two owner rows and violate the
        // IMMEDIATE constraint within the transaction.
        await tx.delete(member).where(eq(member.id, currentMember.id));

        // Revoke this user's MCP OAuth refresh tokens for the org they are
        // leaving so their long-lived tokens cannot be cycled into fresh
        // org-scoped access after they no longer belong to it.
        await tx
          .delete(mcpOauthRefreshTokens)
          .where(
            and(
              eq(mcpOauthRefreshTokens.userId, session.user.id),
              eq(mcpOauthRefreshTokens.organizationId, organizationId)
            )
          );

        await tx
          .update(member)
          .set({ role: "owner" })
          .where(eq(member.id, newOwnerMemberId));

        // Current member already deleted above; skip the unconditional delete.
        if (getActiveOrgId(session) === organizationId) {
          await tx
            .update(sessions)
            .set({ activeOrganizationId: null })
            .where(eq(sessions.token, hashSessionToken(sessionToken)));
        }

        return { success: true, ownershipTransferredTo: newOwnerMemberId };
      }

      await tx.delete(member).where(eq(member.id, currentMember.id));

      // Revoke this user's MCP OAuth refresh tokens for the org they are
      // leaving so their long-lived tokens cannot be cycled into fresh
      // org-scoped access after they no longer belong to it.
      await tx
        .delete(mcpOauthRefreshTokens)
        .where(
          and(
            eq(mcpOauthRefreshTokens.userId, session.user.id),
            eq(mcpOauthRefreshTokens.organizationId, organizationId)
          )
        );

      if (getActiveOrgId(session) === organizationId) {
        await tx
          .update(sessions)
          .set({ activeOrganizationId: null })
          .where(eq(sessions.token, hashSessionToken(sessionToken)));
      }

      return { success: true };
    });

    if (!result.success) {
      const errorMessages: Record<
        LeaveError,
        { message: string; status: number }
      > = {
        NOT_MEMBER: {
          message: "You are not a member of this organization",
          status: 403,
        },
        NEW_OWNER_REQUIRED: {
          message:
            "You must assign a new owner before leaving. Provide newOwnerMemberId.",
          status: 400,
        },
        NEW_OWNER_NOT_ACCEPTED_MEMBER: {
          message:
            "Selected user is not an accepted member of this organization. Only members who have accepted their invitation can be assigned as owner.",
          status: 400,
        },
        NEW_OWNER_SAME_AS_CURRENT: {
          message: "Cannot assign yourself as the new owner",
          status: 400,
        },
      };

      const { message, status } = errorMessages[result.error];
      return NextResponse.json({ error: message }, { status });
    }

    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId,
        authMethod: "session",
      },
      action: "member.left",
      resourceType: "member",
      resourceId: session.user.id,
      metadata: buildAuditMetadata(request),
    });

    if (result.ownershipTransferredTo) {
      await recordAuditEvent({
        actor: {
          userId: session.user.id,
          organizationId,
          authMethod: "session",
        },
        action: "member.role_changed",
        resourceType: "member",
        resourceId: result.ownershipTransferredTo,
        after: { role: "owner" },
        metadata: buildAuditMetadata(request),
      });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    logSystemError(ErrorCategory.DATABASE, "Leave organization failed", err, {
      endpoint: "/api/organizations/[organizationId]/leave",
      operation: "leave",
    });
    return NextResponse.json(
      { error: "Failed to leave organization" },
      { status: 500 }
    );
  }
}
