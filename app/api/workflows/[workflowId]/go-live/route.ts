import { eq, inArray } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publicTags, workflowPublicTags, workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import {
  buildActor,
  buildAuditMetadata,
  recordAuditEvent,
} from "@/lib/security/audit-log";
import { getWorkflowAccess } from "@/lib/workflow/access";

export async function PUT(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  try {
    const { workflowId } = await context.params;

    // Listing a workflow is organization-scoped, so it resolves auth the same
    // way the other workflow mutation routes do rather than reading the
    // session directly. That admits `kh_` keys.
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE);
    if (scopeError) {
      return scopeError;
    }

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId: authContext.userId,
      organizationId: authContext.organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: a soft-deleted workflow cannot be taken live.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const name = body.name?.trim();
    const rawMode = body.mode;
    const mode: "public" | "unlisted" =
      rawMode === "unlisted" ? "unlisted" : "public";

    if (rawMode !== undefined && rawMode !== "public" && rawMode !== "unlisted") {
      return NextResponse.json(
        { error: "Invalid mode. Must be 'public' or 'unlisted'." },
        { status: 400 }
      );
    }

    const publicTagIds: string[] = Array.isArray(body.publicTagIds)
      ? body.publicTagIds
      : [];

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Unlisted = link-only sharing; tags are a Hub-discovery feature, so
    // reject tag payloads under unlisted rather than silently dropping them.
    if (mode === "unlisted" && publicTagIds.length > 0) {
      return NextResponse.json(
        { error: "Tags are not allowed when sharing as unlisted." },
        { status: 400 }
      );
    }

    if (publicTagIds.length > 5) {
      return NextResponse.json(
        { error: "Maximum 5 tags allowed" },
        { status: 400 }
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .update(workflows)
        .set({
          name,
          visibility: mode,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, workflowId));

      // Unlisted workflows never carry Hub tags; clear any leftover rows
      // from a previous public listing so demote-to-unlisted is clean.
      await tx
        .delete(workflowPublicTags)
        .where(eq(workflowPublicTags.workflowId, workflowId));

      if (mode === "public" && publicTagIds.length > 0) {
        await tx.insert(workflowPublicTags).values(
          publicTagIds.map((tagId) => ({
            workflowId,
            publicTagId: tagId,
          }))
        );
      }
    });

    const updatedWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!updatedWorkflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Marketplace tab caches its leaderboard (incl. tag column) for 60s.
    // If this workflow is listed, the tag set the user just chose should
    // appear immediately rather than after the next revalidation tick.
    if (updatedWorkflow.isListed) {
      revalidateTag("marketplace", "max");
    }

    const publicTagNames =
      publicTagIds.length > 0
        ? (
            await db
              .select({ name: publicTags.name })
              .from(publicTags)
              .where(inArray(publicTags.id, publicTagIds))
          ).map((r) => r.name)
        : [];
    await recordAuditEvent({
      actor: buildActor(authContext),
      action: mode === "public" ? "workflow.listed" : "workflow.listing_updated",
      resourceType: "workflow",
      resourceId: workflowId,
      before: { visibility: workflow.visibility, name: workflow.name },
      after: {
        visibility: mode,
        name,
        publicTags: publicTagNames.join(", ") || null,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      ...updatedWorkflow,
      createdAt: updatedWorkflow.createdAt.toISOString(),
      updatedAt: updatedWorkflow.updatedAt.toISOString(),
      isOwner: true,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[GoLive] Failed to go live", error, { endpoint: "/api/workflows/[workflowId]/go-live", operation: "put" });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to go live",
      },
      { status: 500 }
    );
  }
}
