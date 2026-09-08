import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await context.params;

    const authResult = await getDualAuthContext(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const scopeError = requireScope(authResult.scope, SCOPE_MCP_WRITE, {
      credentialType: authResult.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { organizationId, userId, authMethod, apiKeyId } = authResult;
    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (body.name !== undefined) {
      const name = body.name?.trim();
      if (!name) {
        return NextResponse.json(
          { error: "Name cannot be empty" },
          { status: 400 }
        );
      }
      updateData.name = name;
    }

    if (body.description !== undefined) {
      updateData.description = body.description?.trim() || null;
    }

    if (body.color !== undefined) {
      updateData.color = body.color || null;
    }

    const [existing] = await db
      .select({
        name: projects.name,
        description: projects.description,
        color: projects.color,
      })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .limit(1);

    const [updated] = await db
      .update(projects)
      .set(updateData)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await recordAuditEvent({
      actor: { userId, organizationId, authMethod, apiKeyId },
      action: "project.updated",
      resourceType: "project",
      resourceId: updated.id,
      before: {
        name: existing?.name,
        description: existing?.description,
        color: existing?.color,
      },
      after: {
        name: updated.name,
        description: updated.description,
        color: updated.color,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Projects] Failed to update project",
      error,
      { endpoint: "/api/projects/[projectId]", operation: "update" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update project",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await context.params;

    const authResult = await getDualAuthContext(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const scopeError = requireScope(authResult.scope, SCOPE_MCP_WRITE, {
      credentialType: authResult.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { organizationId, userId, authMethod, apiKeyId } = authResult;
    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .returning({ id: projects.id, name: projects.name });

    if (!deleted) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await recordAuditEvent({
      actor: { userId, organizationId, authMethod, apiKeyId },
      action: "project.deleted",
      resourceType: "project",
      resourceId: deleted.id,
      before: { name: deleted.name },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Projects] Failed to delete project",
      error,
      { endpoint: "/api/projects/[projectId]", operation: "delete" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete project",
      },
      { status: 500 }
    );
  }
}
