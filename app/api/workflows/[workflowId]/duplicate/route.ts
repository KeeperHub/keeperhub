import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { syncPersistedWorkflowSchedule } from "@/lib/schedule-service";
import { generateId } from "@/lib/utils/id";
import { remapTemplateRefsInString } from "@/lib/utils/template";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
// Node type for type-safe node manipulation
type WorkflowNodeLike = {
  id: string;
  data?: {
    config?: {
      integrationId?: string;
      [key: string]: unknown;
    };
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Recursively rewrite a single value (string, object, or array) using old->new node ID map */
function remapTemplateRefsInValue(
  value: unknown,
  idMap: Map<string, string>
): unknown {
  if (typeof value === "string") {
    return remapTemplateRefsInString(value, idMap);
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapTemplateRefsInValue(item, idMap));
  }
  if (typeof value === "object" && value !== null) {
    return remapTemplateRefsInConfig(value as Record<string, unknown>, idMap);
  }
  return value;
}

/** Recursively rewrite {{@nodeId:...}} template refs in config using old->new node ID map */
function remapTemplateRefsInConfig(
  config: Record<string, unknown> | undefined,
  idMap: Map<string, string>
): Record<string, unknown> | undefined {
  if (!config || typeof config !== "object") {
    return config;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = remapTemplateRefsInValue(value, idMap);
  }
  return result;
}

/** Duplicate nodes with new IDs, strip integration IDs, and remap template refs in config */
function duplicateNodes(
  oldNodes: WorkflowNodeLike[],
  idMap: Map<string, string>
): WorkflowNodeLike[] {
  return oldNodes.map((node) => {
    const newId = idMap.get(node.id) ?? nanoid();
    const newNode: WorkflowNodeLike = { ...node, id: newId };
    if (newNode.data) {
      const data = { ...newNode.data };
      if (data.config) {
        const { integrationId: _, ...configWithoutIntegration } = data.config;
        data.config = remapTemplateRefsInConfig(
          configWithoutIntegration,
          idMap
        );
      }
      data.status = "idle";
      newNode.data = data;
    }
    return newNode;
  });
}

// Edge type for type-safe edge manipulation
type WorkflowEdgeLike = {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
};

// Helper to update edge references to new node IDs
function updateEdgeReferences(
  edges: WorkflowEdgeLike[],
  oldNodes: WorkflowNodeLike[],
  newNodes: WorkflowNodeLike[]
): WorkflowEdgeLike[] {
  // Create mapping from old node IDs to new node IDs
  const idMap = new Map<string, string>();
  oldNodes.forEach((oldNode, index) => {
    idMap.set(oldNode.id, newNodes[index].id);
  });

  return edges.map((edge) => ({
    ...edge,
    id: nanoid(),
    source: idMap.get(edge.source) || edge.source,
    target: idMap.get(edge.target) || edge.target,
  }));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Sequential workflow duplication logic
export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { userId, organizationId } = authContext;

    if (!userId && !organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The duplicate is owned by the caller's org (organization_id is NOT NULL).
    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 409 }
      );
    }

    // Find the workflow to duplicate
    const sourceWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!sourceWorkflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(sourceWorkflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // If not owner, check if workflow is public
    if (!access.hasFullAccess && sourceWorkflow.visibility !== "public") {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // KEEP-440: a soft-deleted workflow cannot be duplicated.
    if (access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Generate new IDs for nodes
    const oldNodes = sourceWorkflow.nodes as WorkflowNodeLike[];
    const idMap = new Map<string, string>();
    for (const n of oldNodes) {
      idMap.set(n.id, nanoid());
    }
    const duplicatedNodes = duplicateNodes(oldNodes, idMap);
    const duplicatedEdges = updateEdgeReferences(
      sourceWorkflow.edges as WorkflowEdgeLike[],
      oldNodes,
      duplicatedNodes
    );

    // Sanitize nodes/edges: strip React Flow UI state and normalize formats
    const sanitized = sanitizeWorkflowData(
      duplicatedNodes as Record<string, unknown>[],
      duplicatedEdges as Record<string, unknown>[]
    );
    const newNodes = sanitized.nodes;
    const newEdges = sanitized.edges;

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(newNodes),
      organizationId
    );
    if (featureGuard.blocked) {
      return featureGuard.response;
    }

    // Count workflows in the owning org to generate a unique name.
    const existingWorkflows = await db.query.workflows.findMany({
      where: and(
        eq(workflows.organizationId, organizationId),
        workflowNotDeleted()
      ),
    });

    // Generate a unique name
    const baseName = `${sourceWorkflow.name} (Copy)`;
    let workflowName = baseName;
    const existingNames = new Set(existingWorkflows.map((w) => w.name));

    if (existingNames.has(workflowName)) {
      let counter = 2;
      while (existingNames.has(`${baseName} ${counter}`)) {
        counter += 1;
      }
      workflowName = `${baseName} ${counter}`;
    }

    // Create the duplicated workflow
    const newWorkflowId = generateId();
    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: newWorkflowId,
        name: workflowName,
        description: sourceWorkflow.description,
        nodes: newNodes,
        edges: newEdges,
        userId: userId ?? sourceWorkflow.userId,
        organizationId,
        isAnonymous: false,
        visibility: "private", // Duplicated workflows are always private
        sourceWorkflowId: sourceWorkflow.visibility === "public" ? workflowId : null,
      })
      .returning();

    // The copy needs its own schedule row. It is created disabled, so the row
    // stays inert until the user enables the copy.
    await syncPersistedWorkflowSchedule(
      newWorkflow.id,
      newNodes as Parameters<typeof syncPersistedWorkflowSchedule>[1],
      "/api/workflows/[workflowId]/duplicate"
    );

    return NextResponse.json({
      ...newWorkflow,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
      isOwner: true,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to duplicate workflow",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/duplicate",
        operation: "create",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to duplicate workflow",
      },
      { status: 500 }
    );
  }
}
