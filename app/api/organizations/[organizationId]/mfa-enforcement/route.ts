import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  invalidateOrgMfaEnforcement,
  parseEnforcedFactors,
} from "@/lib/mfa/org-mfa-enforcement";
import type { StepUpFactor } from "@/lib/mfa/step-up-policy";
import type { AuthMethod } from "@/lib/middleware/auth-helpers";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type OwnerOk = {
  ok: true;
  userId: string;
  authMethod: AuthMethod;
  apiKeyId: string | null;
  scope?: string;
};
type OwnerErr = { ok: false; status: number; error: string };

// MFA enforcement is a security-critical org setting, so only the owner may
// read or change it (stricter than the owner+admin digest settings).
async function requireOrgRole(
  request: Request,
  organizationId: string,
  allowedRoles: ReadonlySet<string> = new Set(["owner"])
): Promise<OwnerOk | OwnerErr> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { ok: false, status: authContext.status, error: authContext.error };
  }
  const { userId, organizationId: callerOrgId, authMethod } = authContext;
  if (!userId) {
    return { ok: false, status: 400, error: "Auth context missing user" };
  }
  if (authMethod === "api-key" && callerOrgId !== organizationId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .limit(1);

  if (!(membership && allowedRoles.has(membership.role))) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return {
    ok: true,
    userId,
    authMethod,
    apiKeyId: authContext.apiKeyId,
    scope: authContext.scope,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    // Admins may read the enforcement status (read-only); only the owner writes.
    const access = await requireOrgRole(
      request,
      organizationId,
      new Set(["owner", "admin"])
    );
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    const [row] = await db
      .select({
        enforceMfa: organization.enforceMfa,
        enforcedMfaFactors: organization.enforcedMfaFactors,
      })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    return NextResponse.json({
      enforce: row?.enforceMfa ?? false,
      factors: parseEnforcedFactors(row?.enforcedMfaFactors),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to load org MFA enforcement",
      error,
      { endpoint: "/api/organizations/[organizationId]/mfa-enforcement" }
    );
    return NextResponse.json(
      { error: "Failed to load settings" },
      { status: 500 }
    );
  }
}

type PutBody = {
  enforce?: boolean;
  factors?: string[];
};

export async function PUT(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    const owner = await requireOrgRole(request, organizationId);
    if (!owner.ok) {
      return NextResponse.json(
        { error: owner.error },
        { status: owner.status }
      );
    }

    const scopeError = requireScope(owner.scope, SCOPE_MCP_WRITE, {
      credentialType: owner.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const body = (await request.json().catch(() => ({}))) as PutBody;
    const enforce = Boolean(body.enforce);
    const factors: StepUpFactor[] = parseEnforcedFactors(body.factors);

    // Turning enforcement on with no factor selected would gate members against
    // a requirement nobody can satisfy. Require at least one factor when on.
    if (enforce && factors.length === 0) {
      return NextResponse.json(
        {
          error: "Select at least one factor to enforce.",
          code: "no_factor_selected",
        },
        { status: 400 }
      );
    }

    const enforcedMfaFactors = enforce ? factors : null;
    await db
      .update(organization)
      .set({ enforceMfa: enforce, enforcedMfaFactors })
      .where(eq(organization.id, organizationId));

    invalidateOrgMfaEnforcement(organizationId);

    await recordAuditEvent({
      actor: {
        userId: owner.userId,
        organizationId,
        authMethod: owner.authMethod,
        apiKeyId: owner.apiKeyId,
      },
      action: "org.mfa_enforcement_changed",
      resourceType: "organization",
      resourceId: organizationId,
      after: { enforce, factors: enforcedMfaFactors },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ enforce, factors });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to save org MFA enforcement",
      error,
      { endpoint: "/api/organizations/[organizationId]/mfa-enforcement" }
    );
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
