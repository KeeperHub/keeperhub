import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { type DualAuthContext, auditFromAuth, authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { IntervalTooSmallError } from "@/lib/cron-utils";
import {
  extractScheduleConfig,
  syncPersistedWorkflowSchedule,
} from "@/lib/schedule-service";
import { generateId } from "@/lib/utils/id";
import {
  stripIntegrationsFromImportNodes,
  WORKFLOW_EXPORT_VERSION,
  workflowExportV1Schema,
} from "@/lib/workflow/export-schema";
import { sanitizeWorkflowData } from "@/lib/workflow/editor/sanitize-nodes";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";

const versionedBodySchema = z
  .object({ version: z.unknown() })
  .passthrough();

const MAX_IMPORT_BYTES = 1_048_576; // 1 MB — locked by CONTEXT.md (D-04)

export async function POST(request: Request): Promise<NextResponse> {
  // SEC-02: Reject oversized payloads BEFORE parsing the body. Content-Length
  // is advisory (a hostile client may omit it), so this is a fast-fail path,
  // not the only defense. The Zod .max() caps in workflowExportV1Schema are
  // the ultimate backstop.
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_BYTES) {
      return NextResponse.json(
        {
          error: `Import too large: ${contentLength} bytes > ${MAX_IMPORT_BYTES} bytes`,
        },
        { status: 413 }
      );
    }
  }

  let authContext: DualAuthContext | null = null;
  try {
    authContext = await getDualAuthContext(request);
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
    // The org owns the workflow (organization_id is NOT NULL).
    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 409 }
      );
    }

    // Anonymous (auto-provisioned, not signed-in) sessions cannot import.
    // API key and OAuth callers are real principals and pass through.
    if (authContext.authMethod === "session") {
      const session = await auth.api.getSession({ headers: request.headers });
      if (isAnonymousUser(session?.user)) {
        return NextResponse.json(
          { error: "Sign in to import workflows" },
          { status: 403 }
        );
      }
    }

    const rawBody: unknown = await request.json();

    const versionCheck = versionedBodySchema.safeParse(rawBody);
    if (!versionCheck.success) {
      return NextResponse.json(
        { error: "Invalid workflow export: not a JSON object" },
        { status: 400 }
      );
    }
    if (versionCheck.data.version !== WORKFLOW_EXPORT_VERSION) {
      return NextResponse.json(
        {
          error: `Unsupported workflow export version: ${String(
            versionCheck.data.version
          )}. Expected version ${WORKFLOW_EXPORT_VERSION}.`,
        },
        { status: 400 }
      );
    }

    const parsed = workflowExportV1Schema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid workflow export format",
          details: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const exportPayload = parsed.data;

    const importNodes = stripIntegrationsFromImportNodes(exportPayload.nodes);
    const sanitized = sanitizeWorkflowData(
      importNodes,
      exportPayload.edges as Record<string, unknown>[]
    );

    // Org principal: the imported workflow is org-owned (matches runtime).
    const validation = await validateWorkflowIntegrations(
      sanitized.nodes,
      organizationId
    );
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    // Same pre-check the create and PATCH handlers run, so no import can
    // persist an interval the dispatcher cannot honour.
    try {
      extractScheduleConfig(
        sanitized.nodes as Parameters<typeof extractScheduleConfig>[0]
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

    const actionConfigValidation = validateWorkflowActionConfigs(
      sanitized.nodes
    );
    if (!actionConfigValidation.valid) {
      return NextResponse.json(
        formatActionConfigValidationResponse(actionConfigValidation),
        { status: 422 }
      );
    }

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(sanitized.nodes),
      organizationId
    );
    if (featureGuard.blocked) {
      return featureGuard.response;
    }

    const workflowId = generateId();
    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: exportPayload.workflow.name,
        description: exportPayload.workflow.description,
        nodes: sanitized.nodes,
        edges: sanitized.edges,
        userId,
        organizationId,
        isAnonymous: false,
      })
      .returning();

    // An imported Schedule trigger needs its own row. The import lands
    // disabled, so the row stays inert until the user enables it.
    await syncPersistedWorkflowSchedule(
      newWorkflow.id,
      sanitized.nodes as Parameters<typeof syncPersistedWorkflowSchedule>[1],
      "/api/workflows/import"
    );

    // Aggregate-only counter to avoid Prometheus label-cardinality blow-up.
    // Per-workflow attribution is available via the structured logs on this
    // route if needed.
    getMetricsCollector().incrementCounter(MetricNames.WORKFLOW_IMPORTS_TOTAL);

    return NextResponse.json({
      ...newWorkflow,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
      integrationBindings: exportPayload.integrationBindings,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to import workflow", error, {
      endpoint: "/api/workflows/import",
      operation: "import",
      ...auditFromAuth(authContext),
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to import workflow",
      },
      { status: 500 }
    );
  }
}
