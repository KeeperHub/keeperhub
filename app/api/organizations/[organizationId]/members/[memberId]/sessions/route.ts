import { and, desc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member, sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import {
  countryForSessionRow,
  decodeRiskFlags,
} from "@/lib/security/session-location";

// Cap how many sessions we surface per member. The panel is a hygiene
// view ("where has this person signed in from"), not an audit log, so the
// most recent handful is enough and bounds the per-IP enrichment work.
const MEMBER_SESSION_LIMIT = 10;
const ADMIN_ROLES = new Set(["owner", "admin"]);

// Deliberately omits ipAddress, city, and coordinates: the org-admin view
// is country-coarse by design, and the filtering happens here on the
// server so the precise location never reaches the client at all.
type MemberSessionItem = {
  id: string;
  userAgent: string | null;
  country: string | null;
  /** True when login-risk flagged this session (new country / travel). */
  flagged: boolean;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
};

type MemberSessionsResponse = {
  sessions: MemberSessionItem[];
};

/**
 * GET /api/organizations/[organizationId]/members/[memberId]/sessions
 *
 * Read-only per-member session view for org owners/admins: the last N
 * active sessions for one member, with the country + IP + last-used and
 * the anomaly verdict login-risk recorded at sign-in. Drives security
 * hygiene (org owners spotting unfamiliar locations) without engineering
 * having to read the database.
 *
 * Authorization: the caller must themselves be an owner or admin of the
 * same organization. `memberId` is a `member` row id and must belong to
 * `organizationId`; we never trust it to identify a user on its own.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string; memberId: string }> }
): Promise<NextResponse> {
  let authContext: DualAuthContext | null = null;
  try {
    const { organizationId, memberId } = await context.params;

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

    // API keys are org-scoped by design; refuse cross-org reads outright.
    // Session callers may own/administer an org other than their active
    // one, so they're gated on the membership-role query below instead.
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
        { error: "Only organization owners and admins can view sessions" },
        { status: 403 }
      );
    }

    // Resolve the target member strictly within this org so a member id
    // from another org can't be used to read an unrelated user's sessions.
    const [targetMember] = await db
      .select({ userId: member.userId })
      .from(member)
      .where(
        and(eq(member.id, memberId), eq(member.organizationId, organizationId))
      )
      .limit(1);

    if (!targetMember) {
      return NextResponse.json(
        { error: "Member not found in this organization" },
        { status: 404 }
      );
    }

    const rows = await db
      .select({
        id: sessions.id,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
        riskFlagsJson: sessions.riskFlagsJson,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, targetMember.userId),
          gt(sessions.expiresAt, new Date())
        )
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(MEMBER_SESSION_LIMIT);

    // ipAddress is read for the country fallback only; it is never placed
    // on the response so the client receives nothing more precise than the
    // country code.
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const { location, anomaly, reasons } = decodeRiskFlags(
          row.riskFlagsJson
        );
        const country = await countryForSessionRow(location, row.ipAddress);
        return {
          id: row.id,
          userAgent: row.userAgent,
          country,
          flagged: anomaly,
          reasons,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      })
    );

    const body: MemberSessionsResponse = { sessions: enriched };
    return NextResponse.json(body);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to list member sessions",
      error,
      {
        endpoint:
          "/api/organizations/[organizationId]/members/[memberId]/sessions",
        operation: "list",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to load member sessions" },
      { status: 500 }
    );
  }
}
