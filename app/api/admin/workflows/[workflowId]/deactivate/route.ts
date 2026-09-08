import { and, eq, isNull } from "drizzle-orm";
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
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [deactivated] = await tx
        .update(workflows)
        .set({ deactivatedAt: now, enabled: false })
        .where(
          and(
            eq(workflows.id, workflowId),
            isNull(workflows.deactivatedAt),
            isNull(workflows.deletedAt)
          )
        )
        .returning({
          id: workflows.id,
          deactivatedAt: workflows.deactivatedAt,
        });

      if (!deactivated) {
        const [existing] = await tx
          .select({
            id: workflows.id,
            deactivatedAt: workflows.deactivatedAt,
            deletedAt: workflows.deletedAt,
          })
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .limit(1);
        return {
          conflict: existing?.deactivatedAt
            ? ("already_deactivated" as const)
            : ("not_found" as const),
        };
      }

      return {
        workflowId: deactivated.id,
        deactivatedAt: deactivated.deactivatedAt,
      };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json(
          { error: "Workflow not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Workflow is already deactivated" },
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
      action: "workflow.deactivated",
      resourceType: "workflow",
      resourceId: result.workflowId,
      after: { deactivatedAt: result.deactivatedAt?.toISOString() },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Admin] Failed to deactivate workflow",
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
