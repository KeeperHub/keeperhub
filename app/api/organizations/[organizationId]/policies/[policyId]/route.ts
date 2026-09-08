import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { organizationPolicies } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { PolicyEnforcementMode } from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { invalidateOrgPolicies } from "@/lib/policy/store";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { requireOrgPolicyAccess } from "../_lib/access";
import { parsePolicyBody } from "../_lib/parse";

const ENDPOINT = "/api/organizations/[organizationId]/policies/[policyId]";

async function loadPolicy(organizationId: string, policyId: string) {
  const [row] = await db
    .select()
    .from(organizationPolicies)
    .where(
      and(
        eq(organizationPolicies.id, policyId),
        eq(organizationPolicies.organizationId, organizationId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string; policyId: string }> }
): Promise<Response> {
  const { organizationId, policyId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }
  const row = await loadPolicy(organizationId, policyId);
  if (!row) {
    return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  }
  return NextResponse.json({ policy: row });
}

/**
 * Update a policy.
 *
 * Two things make this stricter than an ordinary settings write.
 *
 * A protected policy cannot be relaxed here at all. Relaxing means disabling
 * it, moving it out of enforcement, or replacing its document; each needs a
 * second approver, so this route refuses rather than pretending to apply it.
 *
 * A change delay defers when an edit takes effect. The row updates now and
 * `effectiveAt` moves forward, so the store keeps serving the old rules until
 * the delay elapses. This gives an organization time to notice a change it did
 * not intend before that change starts permitting things.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ organizationId: string; policyId: string }> }
): Promise<Response> {
  const { organizationId, policyId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "write");
  if (!access.ok) {
    return access.response;
  }
  const scopeError = requireScope(access.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }

  const existing = await loadPolicy(organizationId, policyId);
  if (!existing) {
    return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    enabled?: boolean;
    enforcement?: PolicyEnforcementMode;
    document?: unknown;
    changeDelayHours?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json(
      { error: "Request body must be a JSON object" },
      { status: 400 }
    );
  }

  const relaxing =
    body.enabled === false ||
    body.enforcement === PolicyEnforcementMode.MONITOR ||
    body.document !== undefined;

  if (existing.protected && relaxing) {
    return NextResponse.json(
      {
        error:
          "This policy is protected. Relaxing it needs a second approver, which this endpoint does not perform.",
        code: "protected_policy",
      },
      { status: 409 }
    );
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  let warnings: readonly string[] = [];

  if (body.document !== undefined) {
    const parsed = await parsePolicyBody(
      new Request(request.url, {
        method: "POST",
        body: JSON.stringify({
          document: body.document,
          changeDelayHours: body.changeDelayHours,
        }),
        headers: { "content-type": "application/json" },
      })
    );
    if (!parsed.ok) {
      return parsed.response;
    }
    const compiled = compilePolicy({
      id: policyId,
      enabled: true,
      document: parsed.document,
    });
    if (!compiled.ok) {
      return NextResponse.json(
        {
          error: "The policy document is not valid",
          code: "policy_invalid",
          violations: compiled.errors,
        },
        { status: 400 }
      );
    }
    warnings = compiled.warnings;
    update.document = parsed.document;
    update.name = parsed.document.name;
    update.description = parsed.document.description ?? null;
    update.version = existing.version + 1;
    update.changeDelayHours = parsed.changeDelayHours;
    update.effectiveAt = new Date(
      Date.now() + parsed.changeDelayHours * 60 * 60 * 1000
    );
  }

  if (body.enabled !== undefined) {
    update.enabled = body.enabled;
  }
  if (body.enforcement !== undefined) {
    update.enforcement = body.enforcement;
  }

  try {
    const [row] = await db
      .update(organizationPolicies)
      .set(update)
      .where(
        and(
          eq(organizationPolicies.id, policyId),
          eq(organizationPolicies.organizationId, organizationId)
        )
      )
      .returning();

    invalidateOrgPolicies(organizationId);

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action: "org.policy_updated",
      resourceType: "organization_policy",
      resourceId: policyId,
      before: {
        enabled: existing.enabled,
        enforcement: existing.enforcement,
        version: existing.version,
      },
      after: {
        enabled: row?.enabled,
        enforcement: row?.enforcement,
        version: row?.version,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ policy: row, warnings });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Policy] Failed to update policy",
      error,
      {
        endpoint: ENDPOINT,
        operation: "update",
      }
    );
    return apiError(error, "Failed to update policy");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string; policyId: string }> }
): Promise<Response> {
  const { organizationId, policyId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "write");
  if (!access.ok) {
    return access.response;
  }

  const existing = await loadPolicy(organizationId, policyId);
  if (!existing) {
    return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  }
  if (existing.protected) {
    return NextResponse.json(
      {
        error: "This policy is protected. Removing it needs a second approver.",
        code: "protected_policy",
      },
      { status: 409 }
    );
  }

  try {
    await db
      .delete(organizationPolicies)
      .where(
        and(
          eq(organizationPolicies.id, policyId),
          eq(organizationPolicies.organizationId, organizationId)
        )
      );
    invalidateOrgPolicies(organizationId);

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action: "org.policy_deleted",
      resourceType: "organization_policy",
      resourceId: policyId,
      before: { name: existing.name, enforcement: existing.enforcement },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Policy] Failed to delete policy",
      error,
      {
        endpoint: ENDPOINT,
        operation: "delete",
      }
    );
    return apiError(error, "Failed to delete policy");
  }
}
