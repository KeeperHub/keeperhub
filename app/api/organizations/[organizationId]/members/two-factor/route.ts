import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";

const ADMIN_ROLES = new Set(["owner", "admin"]);

type MemberTwoFactorResponse = {
  /** Map of member user id to whether that user has TOTP enrolled. */
  statuses: Record<string, boolean>;
};

/**
 * GET /api/organizations/[organizationId]/members/two-factor
 *
 * Read-only 2FA enrollment view for org owners/admins: which members of the
 * organization have a second factor enrolled. Drives the security-status
 * column in the members list. The boolean comes straight from
 * users.two_factor_enabled; no secret or code material is exposed.
 *
 * Authorization: the caller must be an owner or admin of the same
 * organization. API-key callers are confined to their home org.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  let authContext: DualAuthContext | null = null;
  try {
    const { organizationId } = await context.params;

    authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId: callerOrgId, authMethod } = authContext;
    if (!userId) {
      return NextResponse.json(
        { error: "Auth context missing user. Please recreate the API key." },
        { status: 400 }
      );
    }

    if (authMethod === "api-key" && callerOrgId !== organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [callerMembership] = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId)
        )
      )
      .limit(1);

    if (!(callerMembership && ADMIN_ROLES.has(callerMembership.role))) {
      return NextResponse.json(
        {
          error:
            "Only organization owners and admins can view member 2FA status",
        },
        { status: 403 }
      );
    }

    const rows = await db
      .select({
        userId: member.userId,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(member)
      .innerJoin(users, eq(users.id, member.userId))
      .where(eq(member.organizationId, organizationId));

    const statuses: Record<string, boolean> = {};
    for (const row of rows) {
      statuses[row.userId] = row.twoFactorEnabled === true;
    }

    const body: MemberTwoFactorResponse = { statuses };
    return NextResponse.json(body);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to list member 2FA status",
      error,
      {
        endpoint: "/api/organizations/[organizationId]/members/two-factor",
        operation: "list",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to load member 2FA status" },
      { status: 500 }
    );
  }
}
