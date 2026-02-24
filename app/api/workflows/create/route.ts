import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
// start custom keeperhub code //
import { authenticateApiKey } from "@/keeperhub/lib/api-key-auth";
import { ErrorCategory, logSystemError } from "@/keeperhub/lib/logging";
import { getOrgContext } from "@/keeperhub/lib/middleware/org-context";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { projects, tags, workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

// end keeperhub code //

// start custom keeperhub code //
function createDefaultNodes() {
  const triggerId = nanoid();
  const actionId = nanoid();
  const edgeId = nanoid();

  const triggerNode = {
    id: triggerId,
    type: "trigger" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "",
      description: "",
      type: "trigger" as const,
      config: { triggerType: "Manual" },
      status: "idle" as const,
    },
  };

  const actionNode = {
    id: actionId,
    type: "action" as const,
    position: { x: 272, y: 0 },
    selected: true,
    data: {
      label: "",
      description: "",
      type: "action" as const,
      config: {},
      status: "idle" as const,
    },
  };

  const edge = {
    id: edgeId,
    source: triggerId,
    target: actionId,
    type: "animated",
  };

  return { nodes: [triggerNode, actionNode], edges: [edge] };
}
// end keeperhub code //

// start custom keeperhub code //
// Helper to authenticate and get user context
async function getUserContext(request: Request) {
  // Try API key authentication first
  const apiKeyAuth = await authenticateApiKey(request);

  if (apiKeyAuth.authenticated) {
    // Use the userId from the API key (the user who created the key)
    if (!apiKeyAuth.userId) {
      return {
        error: "API key has no associated user. Please recreate the API key.",
      };
    }

    return {
      userId: apiKeyAuth.userId,
      organizationId: apiKeyAuth.organizationId || null,
    };
  }

  // Fall back to session authentication
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return { error: "Unauthorized" };
  }

  const context = await getOrgContext();
  return {
    userId: session.user.id,
    organizationId: context.organization?.id || null,
  };
}

// Helper to generate workflow name
async function generateWorkflowName(
  name: string,
  userId: string,
  organizationId: string | null
): Promise<string> {
  if (name !== "Untitled Workflow") {
    return name;
  }

  const isAnonymous = !organizationId;
  const userWorkflows = isAnonymous
    ? await db.query.workflows.findMany({
        where: and(
          eq(workflows.userId, userId),
          eq(workflows.isAnonymous, true)
        ),
      })
    : await db.query.workflows.findMany({
        where: and(
          eq(workflows.organizationId, organizationId ?? ""),
          eq(workflows.isAnonymous, false)
        ),
      });

  const count = userWorkflows.length + 1;
  return `Untitled ${count}`;
}
// end keeperhub code //

export async function POST(request: Request) {
  try {
    // start custom keeperhub code //
    const userContext = await getUserContext(request);
    if ("error" in userContext) {
      const status = userContext.error === "Unauthorized" ? 401 : 400;
      return NextResponse.json({ error: userContext.error }, { status });
    }

    const { userId, organizationId } = userContext;
    // end keeperhub code //

    const body = await request.json();

    if (!(body.name && body.nodes && body.edges)) {
      return NextResponse.json(
        { error: "Name, nodes, and edges are required" },
        { status: 400 }
      );
    }

    // Validate that all integrationIds in nodes belong to the current user
    const validation = await validateWorkflowIntegrations(
      body.nodes,
      userId,
      organizationId
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    // start custom keeperhub code //
    // Ensure there are always default nodes (trigger + action) if nodes array is empty
    let nodes = body.nodes;
    let edges = body.edges;
    if (nodes.length === 0) {
      const defaults = createDefaultNodes();
      nodes = defaults.nodes;
      edges = defaults.edges;
    }
    // end keeperhub code //

    // start custom keeperhub code //
    const isAnonymous = !organizationId;
    const workflowName = await generateWorkflowName(
      body.name,
      userId,
      organizationId
    );

    // Validate projectId/tagId ownership when provided
    if (body.projectId !== undefined || body.tagId !== undefined) {
      if (isAnonymous) {
        return NextResponse.json(
          { error: "Cannot assign project or tag without an organization" },
          { status: 400 }
        );
      }

      if (body.projectId) {
        const projRows = await db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, body.projectId),
              eq(projects.organizationId, organizationId ?? "")
            )
          );
        if (projRows.length === 0) {
          return NextResponse.json(
            { error: "Project not found in this organization" },
            { status: 404 }
          );
        }
      }

      if (body.tagId) {
        const tagRows = await db
          .select({ id: tags.id })
          .from(tags)
          .where(
            and(
              eq(tags.id, body.tagId),
              eq(tags.organizationId, organizationId ?? "")
            )
          );
        if (tagRows.length === 0) {
          return NextResponse.json(
            { error: "Tag not found in this organization" },
            { status: 404 }
          );
        }
      }
    }
    // end keeperhub code //

    // Generate workflow ID first
    const workflowId = generateId();

    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: workflowName,
        description: body.description,
        nodes,
        edges,
        userId,
        // start custom keeperhub code //
        organizationId,
        isAnonymous,
        projectId: body.projectId || null,
        tagId: body.tagId || null,
        // end keeperhub code //
      })
      .returning();

    return NextResponse.json({
      ...newWorkflow,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to create workflow", error, {
      endpoint: "/api/workflows/create",
      operation: "create",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create workflow",
      },
      { status: 500 }
    );
  }
}
