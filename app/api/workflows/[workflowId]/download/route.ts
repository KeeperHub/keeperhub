import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { type DualAuthContext, auditFromAuth, authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { buildWorkflowExportV1 } from "@/lib/workflow/export-schema";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const FILENAME_SANITIZE_REGEX = /[^a-z0-9]+/g;
const TRIM_DASHES_REGEX = /^-+|-+$/g;

function sanitizeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(FILENAME_SANITIZE_REGEX, "-")
    .replace(TRIM_DASHES_REGEX, "");
  return slug || "workflow";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  let authContext: DualAuthContext | null = null;
  try {
    const { workflowId } = await context.params;

    authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }
    const { userId, organizationId } = authContext;

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
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: download is unavailable for a soft-deleted workflow.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const exportPayload = buildWorkflowExportV1({
      name: workflow.name,
      description: workflow.description,
      nodes: workflow.nodes as WorkflowNode[],
      edges: workflow.edges as WorkflowEdge[],
    });

    const fileName = `${sanitizeFileName(workflow.name)}.workflow.json`;
    // RFC 5987: encode the filename so non-ASCII or special characters
    // cannot break the Content-Disposition header even if sanitization
    // is loosened later. The unquoted "filename=" is kept as a fallback
    // for older clients.
    const encodedFileName = encodeURIComponent(fileName);

    // Aggregate-only counter to avoid Prometheus label-cardinality blow-up.
    // Per-workflow attribution is available via the structured logs on this
    // route if needed.
    getMetricsCollector().incrementCounter(MetricNames.WORKFLOW_EXPORTS_TOTAL);

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to export workflow",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/download",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to export workflow",
      },
      { status: 500 }
    );
  }
}
