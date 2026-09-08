import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";
import { authenticateKhAdmin } from "@/lib/kh-admin-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
): Promise<NextResponse> {
  const auth = authenticateKhAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { orgId } = await context.params;

  try {
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [deactivatedOrg] = await tx
        .update(organization)
        .set({ deactivatedAt: now })
        .where(
          and(eq(organization.id, orgId), isNull(organization.deactivatedAt))
        )
        .returning({
          id: organization.id,
          deactivatedAt: organization.deactivatedAt,
        });

      if (!deactivatedOrg) {
        const [existing] = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, orgId))
          .limit(1);
        return {
          conflict: existing
            ? ("already_deactivated" as const)
            : ("not_found" as const),
        };
      }

      const deactivatedWorkflows = await tx
        .update(workflows)
        .set({ deactivatedAt: now, enabled: false })
        .where(
          and(
            eq(workflows.organizationId, orgId),
            isNull(workflows.deletedAt),
            isNull(workflows.deactivatedAt)
          )
        )
        .returning({ id: workflows.id });

      return {
        orgId: deactivatedOrg.id,
        deactivatedAt: deactivatedOrg.deactivatedAt,
        workflowsDeactivated: deactivatedWorkflows.length,
      };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json(
          { error: "Organization not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Organization is already deactivated" },
        { status: 409 }
      );
    }

    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: result.orgId,
        authMethod: "kh-admin",
        actorLabel: "KeeperHub admin",
      },
      action: "org.deactivated",
      resourceType: "organization",
      resourceId: result.orgId,
      after: {
        deactivatedAt: result.deactivatedAt?.toISOString(),
        workflowsDeactivated: result.workflowsDeactivated,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Admin] Failed to deactivate org",
      error,
      {
        orgId,
      }
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
