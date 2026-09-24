import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { organizationPolicies } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import type { PolicyDocument, PolicyEnforcementMode } from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { scorePolicy } from "@/lib/policy/coverage";
import { invalidateOrgPolicies } from "@/lib/policy/store";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { requireOrgPolicyAccess } from "./_lib/access";
import { parsePolicyBody } from "./_lib/parse";

const ENDPOINT = "/api/organizations/[organizationId]/policies";

/**
 * The share of guard dimensions this policy binds, or null when the stored
 * document no longer compiles. Null is honest; a zero would read as "binds
 * nothing" when the truth is "cannot be read".
 */
function coverageOf(
  id: string,
  document: PolicyDocument,
  enforcement: PolicyEnforcementMode
): ReturnType<typeof scorePolicy> | null {
  const out = compilePolicy({ id, enabled: true, document, enforcement });
  return out.ok ? scorePolicy(out.compiled) : null;
}

/** Every policy in the organization, newest first. Read is admin or owner. */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  const url = new URL(request.url);
  const req = parsePageRequest(url, { fallback: 20 });
  const query = url.searchParams.get("q")?.trim() ?? "";

  try {
    // The document holds the capabilities, resources and statement ids, so
    // casting it to text is what makes "find the policy that mentions this
    // contract" work without a column per searchable field.
    const term = `%${query}%`;
    const filters = and(
      eq(organizationPolicies.organizationId, organizationId),
      query
        ? or(
            ilike(organizationPolicies.name, term),
            ilike(organizationPolicies.description, term),
            sql`${organizationPolicies.document}::text ILIKE ${term}`
          )
        : undefined
    );

    // Ordered by when each was written, not when it was last touched. Sorting
    // by updatedAt moved a policy to the top the moment somebody edited it, so
    // the list rearranged itself under the reader every time they changed
    // anything, and the row they were working on was never where they left it.
    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(organizationPolicies)
        .where(filters)
        .orderBy(asc(organizationPolicies.createdAt))
        .limit(req.pageSize)
        .offset(req.offset),
      db.select({ value: count() }).from(organizationPolicies).where(filters),
    ]);

    const items = rows.map((row) => ({
      // Coverage is computed rather than stored, so it can never go stale
      // against a document that changed. A policy that no longer compiles
      // reports no coverage rather than a misleading number.
      coverage: coverageOf(row.id, row.document, row.enforcement),
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      enforcement: row.enforcement,
      version: row.version,
      changeDelayHours: row.changeDelayHours,
      effectiveAt: row.effectiveAt,
      protected: row.protected,
      document: row.document,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return NextResponse.json(buildPage(items, totalRow?.value ?? 0, req, url));
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Policy] Failed to list policies",
      error,
      {
        endpoint: ENDPOINT,
        operation: "list",
      }
    );
    return apiError(error, "Failed to list policies");
  }
}

/**
 * Create a policy.
 *
 * The document is compiled before it is stored, so an unsound one is refused
 * here rather than silently failing to protect anything later. Compile
 * warnings are returned alongside a successful create: they describe rules that
 * are legal but probably not what the author meant, which is not a reason to
 * refuse the save.
 *
 * New policies are created in monitor mode. Turning enforcement on is a
 * separate, deliberate edit.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "write");
  if (!access.ok) {
    return access.response;
  }
  const scopeError = requireScope(access.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }

  const parsed = await parsePolicyBody(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const compiled = compilePolicy({
    id: "pending",
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

  try {
    const existing = await db
      .select({ id: organizationPolicies.id })
      .from(organizationPolicies)
      .where(
        and(
          eq(organizationPolicies.organizationId, organizationId),
          eq(organizationPolicies.name, parsed.document.name)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        {
          error: "A policy with that name already exists",
          code: "duplicate_name",
        },
        { status: 409 }
      );
    }

    const [row] = await db
      .insert(organizationPolicies)
      .values({
        organizationId,
        name: parsed.document.name,
        description: parsed.document.description,
        // Always starts observing. Enforcement is opted into, never defaulted.
        enforcement: "monitor",
        document: parsed.document,
        changeDelayHours: parsed.changeDelayHours,
        createdBy: access.userId,
      })
      .returning();

    invalidateOrgPolicies(organizationId);

    await recordAuditEvent({
      actor: {
        userId: access.userId,
        organizationId,
        authMethod: access.authMethod,
        apiKeyId: access.apiKeyId,
      },
      action: "org.policy_created",
      resourceType: "organization_policy",
      resourceId: row?.id,
      after: {
        name: parsed.document.name,
        enforcement: "monitor",
        manages: parsed.document.manages,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(
      { policy: row, warnings: compiled.warnings },
      { status: 201 }
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Policy] Failed to create policy",
      error,
      {
        endpoint: ENDPOINT,
        operation: "create",
      }
    );
    return apiError(error, "Failed to create policy");
  }
}
