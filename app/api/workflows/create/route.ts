import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { recordWorkflowCreatedFromSource } from "@/lib/metrics/collectors/prometheus";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { recordWorkflowSnapshot } from "@/lib/workflow/history";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { projects, tags, workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import {
  beginIdempotentFromRequest,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";
import { IntervalTooSmallError } from "@/lib/cron-utils";
import {
  extractScheduleConfig,
  syncPersistedWorkflowSchedule,
} from "@/lib/schedule-service";
import { generateId } from "@/lib/utils/id";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";
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

// Helper to generate workflow name
async function generateWorkflowName(
  name: string,
  organizationId: string
): Promise<string> {
  if (name !== "Untitled Workflow") {
    return name;
  }

  // The org owns every workflow, so the untitled counter is org-scoped.
  const orgWorkflows = await db.query.workflows.findMany({
    where: and(
      eq(workflows.organizationId, organizationId),
      workflowNotDeleted()
    ),
  });

  const count = orgWorkflows.length + 1;
  return `Untitled ${count}`;
}

export async function POST(request: Request) {
  try {
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
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The org owns the workflow (organization_id is NOT NULL). Every account
    // has an org, so a missing one is an unexpected state, not anonymous use.
    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 409 }
      );
    }

    const body = await request.json();

    if (!(body.name && body.nodes && body.edges)) {
      return NextResponse.json(
        { error: "Name, nodes, and edges are required" },
        { status: 400 }
      );
    }

    // Idempotency: a retry with the same key + body returns the original
    // created workflow instead of creating a duplicate shell.
    const idem = await beginIdempotentFromRequest({
      request,
      organizationId,
      scope: "workflow-create",
      requestBody: body,
    });
    if (idem) {
      const early = idempotencyEarlyResponse(idem);
      if (early) {
        return NextResponse.json(early.body, { status: early.status });
      }
    }

    // Ensure there are always default nodes (trigger + action) if nodes array is empty
    let nodes = body.nodes;
    let edges = body.edges;
    if (nodes.length === 0) {
      const defaults = createDefaultNodes();
      nodes = defaults.nodes;
      edges = defaults.edges;
    }

    // Sanitize nodes/edges: strip React Flow UI state and normalize MCP-generated formats
    const sanitized = sanitizeWorkflowData(nodes, edges);
    nodes = sanitized.nodes;
    edges = sanitized.edges;

    // A 201 from this endpoint does not mean the workflow will run. The gate
    // below is an AUTHORIZATION check on integrationId, not an existence
    // check: filterUnauthorizedIntegrationIds treats ids with no matching row
    // as authorized so stale references stay savable, so a fictional
    // integrationId is accepted and persisted verbatim. `network` and
    // `actionType` are not validated against the chain registry or action
    // catalogue here at all. See the fuller note on the PATCH handler in
    // app/api/workflows/[workflowId]/route.ts.
    //
    // Validate the exact shape that will be persisted. The sanitizer moves
    // misplaced root fields into data.config, including integrationId.
    // Org principal: the new workflow is org-owned, so it may only reference
    // the org's integrations (matches the runtime credential fetch).
    const validation = await validateWorkflowIntegrations(
      nodes,
      organizationId
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    // Same pre-check the PATCH handler runs: reject a sub-minimum interval
    // before the insert, so a rejected value never lands as persisted nodes
    // paired with an unregistered schedule.
    try {
      extractScheduleConfig(
        nodes as Parameters<typeof extractScheduleConfig>[0]
      );
    } catch (error) {
      if (error instanceof IntervalTooSmallError) {
        return NextResponse.json(
          { error: "SCHEDULE_INTERVAL_TOO_SMALL", message: error.message },
          { status: 400 }
        );
      }
      throw error;
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

    const workflowName = await generateWorkflowName(body.name, organizationId);

    // Validate projectId/tagId ownership when provided
    if (body.projectId !== undefined || body.tagId !== undefined) {
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
        organizationId,
        isAnonymous: false,
        projectId: body.projectId || null,
        tagId: body.tagId || null,
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      })
      .returning();

    // A Schedule trigger only reaches the dispatcher through a schedule row,
    // so create it here rather than leaving it to the next definition save.
    await syncPersistedWorkflowSchedule(
      newWorkflow.id,
      nodes as Parameters<typeof syncPersistedWorkflowSchedule>[1],
      "/api/workflows/create"
    );

    await recordAuditEvent({
      actor: {
        userId,
        organizationId,
        authMethod: authContext.authMethod,
        apiKeyId: authContext.apiKeyId,
      },
      action: "workflow.created",
      resourceType: "workflow",
      resourceId: newWorkflow.id,
      after: { name: newWorkflow.name, enabled: newWorkflow.enabled },
      metadata: buildAuditMetadata(request),
    });

    // First version snapshot for the change-history timeline.
    await recordWorkflowSnapshot({
      workflowId: newWorkflow.id,
      before: null,
      after: newWorkflow,
      actor: { userId, organizationId, authMethod: authContext.authMethod },
      source: "create",
    });

    // Scan-funnel conversion signal: the scan drawer / pending-scan runner
    // tag their create calls with x-keeperhub-source; everything else counts
    // as "other". Header values outside the allowlist are coerced, so the
    // label cannot be polluted by arbitrary client input.
    recordWorkflowCreatedFromSource(
      request.headers.get("x-keeperhub-source")
    );

    return recordIdempotentResponse(
      idem,
      NextResponse.json({
        ...newWorkflow,
        createdAt: newWorkflow.createdAt.toISOString(),
        updatedAt: newWorkflow.updatedAt.toISOString(),
      })
    );
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
