import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
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
      const [existing] = await tx
        .select({
          id: organization.id,
          deactivatedAt: organization.deactivatedAt,
        })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);

      if (!existing) {
        return { conflict: "not_found" as const };
      }
      if (!existing.deactivatedAt) {
        return { conflict: "not_deactivated" as const };
      }

      await tx
        .update(organization)
        .set({ deactivatedAt: null })
        .where(eq(organization.id, orgId));

      const [{ value: workflowsStillDeactivated }] = await tx
        .select({ value: count() })
        .from(workflows)
        .where(
          and(
            eq(workflows.organizationId, orgId),
            isNotNull(workflows.deactivatedAt),
            isNull(workflows.deletedAt)
          )
        );

      return { orgId, activatedAt: now, workflowsStillDeactivated };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json(
          { error: "Organization not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Organization is not deactivated" },
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
      action: "org.reactivated",
      resourceType: "organization",
      resourceId: result.orgId,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Admin] Failed to activate org",
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
