import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  auditFromAuth,
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type UpdateOrganizationNameRequest = {
  name?: string;
};

export async function PATCH(
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

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { userId, organizationId: callerOrgId, authMethod } = authContext;
    if (!userId) {
      return NextResponse.json(
        { error: "Auth context missing user. Please recreate the API key." },
        { status: 400 }
      );
    }

    // Hard-scope only API-key callers to their own org. Session users may
    // legitimately PATCH an org other than their currently-active session
    // org (a user can own multiple orgs without switching first); the
    // owner-membership query below gates that path on member.role = 'owner'
    // so cross-org owners are still authorized when authenticating via
    // session. API keys are by design org-scoped to the key's home org.
    if (authMethod === "api-key" && callerOrgId !== organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await request.json()) as UpdateOrganizationNameRequest;
    const nextName =
      typeof body.name === "string" ? body.name.trim() : undefined;

    if (!nextName) {
      return NextResponse.json(
        { error: "Organization name is required" },
        { status: 400 }
      );
    }

    if (nextName.length > 120) {
      return NextResponse.json(
        { error: "Organization name is too long" },
        { status: 400 }
      );
    }

    const ownerMembership = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
          eq(member.role, "owner")
        )
      )
      .limit(1);

    if (ownerMembership.length === 0) {
      return NextResponse.json(
        { error: "Only organization owners can update the organization" },
        { status: 403 }
      );
    }

    const [existing] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    const [updated] = await db
      .update(organization)
      .set({ name: nextName })
      .where(eq(organization.id, organizationId))
      .returning({ id: organization.id, name: organization.name });

    if (!updated) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 }
      );
    }

    await recordAuditEvent({
      actor: {
        userId,
        organizationId,
        authMethod,
        apiKeyId: authContext.apiKeyId,
      },
      action: "org.updated",
      resourceType: "organization",
      resourceId: organizationId,
      before: { name: existing?.name },
      after: { name: updated.name },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ organization: updated }, { status: 200 });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to update organization",
      error,
      {
        endpoint: "/api/organizations/[organizationId]",
        operation: "update",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 }
    );
  }
}
