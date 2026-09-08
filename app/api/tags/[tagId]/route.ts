import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tags } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ tagId: string }> }
): Promise<NextResponse> {
  try {
    const { tagId } = await context.params;

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

    if (body.color !== undefined) {
      if (!body.color) {
        return NextResponse.json(
          { error: "Color cannot be empty" },
          { status: 400 }
        );
      }
      updateData.color = body.color;
    }

    const [existing] = await db
      .select({ name: tags.name, color: tags.color })
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.organizationId, organizationId)))
      .limit(1);

    const [updated] = await db
      .update(tags)
      .set(updateData)
      .where(and(eq(tags.id, tagId), eq(tags.organizationId, organizationId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    await recordAuditEvent({
      actor: { userId, organizationId, authMethod, apiKeyId },
      action: "tag.updated",
      resourceType: "tag",
      resourceId: updated.id,
      before: { name: existing?.name, color: existing?.color },
      after: { name: updated.name, color: updated.color },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to update tag", error, {
      endpoint: "/api/tags/[tagId]",
      operation: "patch",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update tag",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ tagId: string }> }
): Promise<NextResponse> {
  try {
    const { tagId } = await context.params;

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
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.organizationId, organizationId)))
      .returning({ id: tags.id, name: tags.name });

    if (!deleted) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    await recordAuditEvent({
      actor: { userId, organizationId, authMethod, apiKeyId },
      action: "tag.deleted",
      resourceType: "tag",
      resourceId: deleted.id,
      before: { name: deleted.name },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to delete tag", error, {
      endpoint: "/api/tags/[tagId]",
      operation: "delete",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete tag",
      },
      { status: 500 }
    );
  }
}
