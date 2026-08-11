import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { getOrgContext } from "@/lib/middleware/org-context";
import { generateId } from "@/lib/utils/id";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";

const CURRENT_WORKFLOW_NAME = "~~__CURRENT__~~";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgContext = await getOrgContext();
    const organizationId = orgContext.organization?.id;
    if (!organizationId) {
      return NextResponse.json({ nodes: [], edges: [] });
    }

    const [currentWorkflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.name, CURRENT_WORKFLOW_NAME),
          eq(workflows.userId, session.user.id),
          eq(workflows.organizationId, organizationId)
        )
      )
      .orderBy(desc(workflows.updatedAt))
      .limit(1);

    if (!currentWorkflow) {
      // Return empty workflow if no current state exists
      return NextResponse.json({
        nodes: [],
        edges: [],
      });
    }

    return NextResponse.json({
      id: currentWorkflow.id,
      nodes: currentWorkflow.nodes,
      edges: currentWorkflow.edges,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get current workflow",
      error,
      {
        endpoint: "/api/workflows/current",
        operation: "get",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get current workflow",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { nodes: rawNodes, edges: rawEdges } = body;

    if (!(rawNodes && rawEdges)) {
      return NextResponse.json(
        { error: "Nodes and edges are required" },
        { status: 400 }
      );
    }

    // Sanitize nodes/edges: strip React Flow UI state and normalize formats
    const sanitized = sanitizeWorkflowData(rawNodes, rawEdges);
    const { nodes, edges } = sanitized;
    const orgContext = await getOrgContext();
    const organizationId = orgContext.organization?.id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 409 }
      );
    }

    // Org principal: drafts are org-owned like any workflow (matches runtime).
    const integrationValidation = await validateWorkflowIntegrations(
      nodes,
      organizationId
    );
    if (!integrationValidation.valid) {
      return NextResponse.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    const actionConfigValidation = validateWorkflowActionConfigs(nodes);
    if (!actionConfigValidation.valid) {
      return NextResponse.json(
        formatActionConfigValidationResponse(actionConfigValidation),
        { status: 422 }
      );
    }

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(nodes),
      organizationId
    );
    if (featureGuard.blocked) {
      return featureGuard.response;
    }

    // Check if current workflow exists for this user in this org.
    // Both filters are required: userId scopes the draft to the editing user,
    // organizationId prevents access after the user has left the org.
    const [existingWorkflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.name, CURRENT_WORKFLOW_NAME),
          eq(workflows.userId, session.user.id),
          eq(workflows.organizationId, organizationId)
        )
      )
      .limit(1);

    if (existingWorkflow) {
      // Update existing current workflow
      const [updatedWorkflow] = await db
        .update(workflows)
        .set({
          nodes,
          edges,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, existingWorkflow.id))
        .returning();

      return NextResponse.json({
        id: updatedWorkflow.id,
        nodes: updatedWorkflow.nodes,
        edges: updatedWorkflow.edges,
      });
    }

    const workflowId = generateId();

    const [savedWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: CURRENT_WORKFLOW_NAME,
        description: "Auto-saved current workflow",
        nodes,
        edges,
        userId: session.user.id,
        organizationId,
        isAnonymous: false,
      })
      .returning();

    return NextResponse.json({
      id: savedWorkflow.id,
      nodes: savedWorkflow.nodes,
      edges: savedWorkflow.edges,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to save current workflow",
      error,
      {
        endpoint: "/api/workflows/current",
        operation: "create",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to save current workflow",
      },
      { status: 500 }
    );
  }
}
