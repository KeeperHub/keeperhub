import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
// start custom keeperhub code //
import { authenticateApiKey } from "@/keeperhub/lib/api-key-auth";
import { ErrorCategory, logSystemError } from "@/keeperhub/lib/logging";
import { getOrgContext } from "@/keeperhub/lib/middleware/org-context";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { projects, publicTags, tags, workflowPublicTags, workflows } from "@/lib/db/schema";
import { syncWorkflowSchedule } from "@/lib/schedule-service";

// end keeperhub code //

// start custom keeperhub code //
async function fetchWorkflowPublicTags(
  workflowId: string
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const rows = await db
    .select({
      id: publicTags.id,
      name: publicTags.name,
      slug: publicTags.slug,
    })
    .from(workflowPublicTags)
    .innerJoin(publicTags, eq(workflowPublicTags.publicTagId, publicTags.id))
    .where(eq(workflowPublicTags.workflowId, workflowId));
  return rows;
}
// end keeperhub code //

// Helper to strip sensitive data from nodes for public viewing
function sanitizeNodesForPublicView(
  nodes: Record<string, unknown>[]
): Record<string, unknown>[] {
  return nodes.map((node) => {
    const sanitizedNode = { ...node };
    if (
      sanitizedNode.data &&
      typeof sanitizedNode.data === "object" &&
      sanitizedNode.data !== null
    ) {
      const data = { ...(sanitizedNode.data as Record<string, unknown>) };
      // Remove integrationId from config to not expose which integrations are used
      if (
        data.config &&
        typeof data.config === "object" &&
        data.config !== null
      ) {
        const { integrationId: _, ...configWithoutIntegration } =
          data.config as Record<string, unknown>;
        data.config = configWithoutIntegration;
      }
      sanitizedNode.data = data;
    }
    return sanitizedNode;
  });
}

// Helper to get authenticated user context for PATCH
async function getAuthContextForPatch(
  request: Request
): Promise<
  | { userId: string | null; organizationId: string | null }
  | { error: string; status: number }
> {
  const apiKeyAuth = await authenticateApiKey(request);

  if (apiKeyAuth.authenticated) {
    return {
      userId: null,
      organizationId: apiKeyAuth.organizationId || null,
    };
  }

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const orgContext = await getOrgContext();
  return {
    userId: session.user.id,
    organizationId: orgContext.organization?.id || null,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // start custom keeperhub code //
    // Try API key authentication first
    const apiKeyAuth = await authenticateApiKey(request);
    let userId: string | null = null;
    let organizationId: string | null = null;

    if (apiKeyAuth.authenticated) {
      // API key authentication successful
      organizationId = apiKeyAuth.organizationId || null;
    } else {
      // Fall back to session authentication
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (session?.user) {
        userId = session.user.id;

        // Get organization context from session
        const orgContext = await getOrgContext();
        organizationId = orgContext.organization?.id || null;
      }
    }
    // end keeperhub code //

    // First, try to find the workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const isOwner = userId === workflow.userId;

    // start custom keeperhub code //
    // Check organization membership for private workflows
    const isSameOrg =
      !workflow.isAnonymous &&
      workflow.organizationId &&
      organizationId === workflow.organizationId;

    // Access control:
    // - Public workflows: anyone can view (sanitized)
    // - Private workflows: owner or org member can view
    // - Anonymous workflows: only owner can view
    if (!isOwner && workflow.visibility !== "public" && !isSameOrg) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const hasFullAccess = isOwner || isSameOrg;

    const workflowTags = await fetchWorkflowPublicTags(workflowId);
    // end keeperhub code //

    // For public workflows viewed by non-owners, sanitize sensitive data
    const responseData = {
      ...workflow,
      nodes: hasFullAccess
        ? workflow.nodes
        : sanitizeNodesForPublicView(
            workflow.nodes as Record<string, unknown>[]
          ),
      publicTags: workflowTags,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
      // Note: `isOwner` controls edit permissions in the frontend.
      // We use `hasFullAccess` here so that all org members can edit,
      // not just the original creator. This is a bit of a misnomer but
      // avoids refactoring the frontend atom naming (isWorkflowOwnerAtom).
      isOwner: hasFullAccess,
    };

    return NextResponse.json(responseData);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflow",
      },
      { status: 500 }
    );
  }
}

// Helper to build update data from request body
function buildUpdateData(
  body: Record<string, unknown>
): Record<string, unknown> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  const fields = [
    "name",
    "description",
    "nodes",
    "edges",
    "visibility",
    "enabled", // keeperhub custom field //
    "projectId", // keeperhub custom field //
    "tagId", // keeperhub custom field //
  ];
  for (const field of fields) {
    if (body[field] !== undefined) {
      updateData[field] = body[field];
    }
  }

  return updateData;
}

// Helper to validate visibility value
function isValidVisibility(visibility: unknown): boolean {
  return (
    visibility === undefined ||
    visibility === "private" ||
    visibility === "public"
  );
}

// Helper to validate workflow access for PATCH/DELETE operations
async function validateWorkflowAccess(
  workflowId: string,
  userId: string | null,
  organizationId: string | null
): Promise<{
  workflow: typeof workflows.$inferSelect | null;
  hasAccess: boolean;
}> {
  const existingWorkflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
  });

  if (!existingWorkflow) {
    return { workflow: null, hasAccess: false };
  }

  const isOwner = userId ? existingWorkflow.userId === userId : false;
  const isSameOrg =
    !existingWorkflow.isAnonymous &&
    existingWorkflow.organizationId &&
    organizationId === existingWorkflow.organizationId;

  return {
    workflow: existingWorkflow,
    hasAccess: isOwner || Boolean(isSameOrg),
  };
}

// start custom keeperhub code //
async function handlePostUpdateSideEffects(
  workflowId: string,
  body: Record<string, unknown>
): Promise<void> {
  if (body.visibility === "private") {
    await db
      .delete(workflowPublicTags)
      .where(eq(workflowPublicTags.workflowId, workflowId));
  }

  if (body.nodes !== undefined) {
    const syncResult = await syncWorkflowSchedule(
      workflowId,
      body.nodes as Parameters<typeof syncWorkflowSchedule>[1]
    );
    if (!syncResult.synced) {
      console.warn(
        `[Workflow] Schedule sync failed for ${workflowId}:`,
        syncResult.error
      );
    }
  }
}
// end keeperhub code //

export async function PATCH(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // start custom keeperhub code //
    const authContext = await getAuthContextForPatch(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId } = authContext;
    const { workflow: existingWorkflow, hasAccess } =
      await validateWorkflowAccess(workflowId, userId, organizationId);

    if (!(existingWorkflow && hasAccess)) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }
    // end keeperhub code //

    const body = await request.json();

    // Validate that all integrationIds in nodes belong to the current user
    if (Array.isArray(body.nodes)) {
      const validation = await validateWorkflowIntegrations(
        body.nodes,
        userId || existingWorkflow.userId,
        organizationId
      );
      if (!validation.valid) {
        return NextResponse.json(
          { error: "Invalid integration references in workflow" },
          { status: 403 }
        );
      }
    }

    // Validate visibility value if provided
    if (!isValidVisibility(body.visibility)) {
      return NextResponse.json(
        { error: "Invalid visibility value. Must be 'private' or 'public'" },
        { status: 400 }
      );
    }

    // start custom keeperhub code //
    // Validate projectId/tagId ownership when provided
    if (body.projectId !== undefined || body.tagId !== undefined) {
      const targetOrgId = existingWorkflow.organizationId || organizationId;

      if (!targetOrgId) {
        if (body.projectId || body.tagId) {
          return NextResponse.json(
            { error: "Cannot assign project or tag without an organization" },
            { status: 400 }
          );
        }
      } else {
        if (body.projectId) {
          const projRows = await db
            .select({ orgId: projects.organizationId })
            .from(projects)
            .where(eq(projects.id, body.projectId));
          if (!(projRows[0] && projRows[0].orgId === targetOrgId)) {
            return NextResponse.json(
              { error: "Project not found in this organization" },
              { status: 404 }
            );
          }
        }
        if (body.tagId) {
          const tagRows = await db
            .select({ orgId: tags.organizationId })
            .from(tags)
            .where(eq(tags.id, body.tagId));
          if (!(tagRows[0] && tagRows[0].orgId === targetOrgId)) {
            return NextResponse.json(
              { error: "Tag not found in this organization" },
              { status: 404 }
            );
          }
        }
      }
    }
    // end keeperhub code //

    const updateData = buildUpdateData(body);

    const [updatedWorkflow] = await db
      .update(workflows)
      .set(updateData)
      .where(eq(workflows.id, workflowId))
      .returning();

    if (!updatedWorkflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // start custom keeperhub code //
    await handlePostUpdateSideEffects(workflowId, body);
    // end keeperhub code //

    return NextResponse.json({
      ...updatedWorkflow,
      createdAt: updatedWorkflow.createdAt.toISOString(),
      updatedAt: updatedWorkflow.updatedAt.toISOString(),
      isOwner: true,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to update workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update workflow",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // start custom keeperhub code //
    // Try API key authentication first
    const apiKeyAuth = await authenticateApiKey(request);
    let userId: string | null = null;
    let organizationId: string | null = null;

    if (apiKeyAuth.authenticated) {
      // API key authentication successful
      organizationId = apiKeyAuth.organizationId || null;
    } else {
      // Fall back to session authentication
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      userId = session.user.id;

      // Get organization context from session
      const orgContext = await getOrgContext();
      organizationId = orgContext.organization?.id || null;
    }

    const { hasAccess } = await validateWorkflowAccess(
      workflowId,
      userId,
      organizationId
    );

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }
    // end keeperhub code //

    await db.delete(workflows).where(eq(workflows.id, workflowId));

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to delete workflow", error, {
      endpoint: "/api/workflows/[workflowId]",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete workflow",
      },
      { status: 500 }
    );
  }
}
