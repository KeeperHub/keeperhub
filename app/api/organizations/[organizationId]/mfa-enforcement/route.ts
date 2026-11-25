import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  invalidateOrgMfaEnforcement,
  parseEnforcedFactors,
} from "@/lib/mfa/org-mfa-enforcement";
import type { StepUpFactor } from "@/lib/mfa/step-up-policy";
import {
  ORG_MANAGERS,
  ORG_OWNER_ONLY,
  requireOrgRole,
} from "@/lib/middleware/require-org-role";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  try {
    const { organizationId } = await context.params;
    // Admins may read the enforcement status (read-only); only the owner writes.
    const access = await requireOrgRole(request, organizationId, ORG_MANAGERS);
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
    // MFA enforcement is a security-critical org setting, so only the owner
    // may change it.
    const owner = await requireOrgRole(request, organizationId, ORG_OWNER_ONLY);
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
