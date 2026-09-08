import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { authenticateKhAdmin } from "@/lib/kh-admin-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  const auth = authenticateKhAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { workflowId } = await context.params;

  try {
    const result = await db.transaction(async (tx) => {
      const [activated] = await tx
        .update(workflows)
        .set({ deactivatedAt: null })
        .where(
          and(
            eq(workflows.id, workflowId),
            isNotNull(workflows.deactivatedAt),
            isNull(workflows.deletedAt)
          )
        )
        .returning({ id: workflows.id });

      if (!activated) {
        const [existing] = await tx
          .select({
            id: workflows.id,
            deactivatedAt: workflows.deactivatedAt,
            deletedAt: workflows.deletedAt,
          })
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .limit(1);

        if (!existing || existing.deletedAt) {
          return { conflict: "not_found" as const };
        }
        return { conflict: "not_deactivated" as const };
      }

      return { workflowId: activated.id };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json(
          { error: "Workflow not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Workflow is not deactivated" },
        { status: 409 }
      );
    }

    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: null,
        authMethod: "kh-admin",
        actorLabel: "KeeperHub admin",
      },
      action: "workflow.reactivated",
      resourceType: "workflow",
      resourceId: result.workflowId,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Admin] Failed to activate workflow",
      error,
      {
        workflowId,
      }
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
