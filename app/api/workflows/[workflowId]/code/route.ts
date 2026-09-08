import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { type DualAuthContext, auditFromAuth, authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { generateWorkflowSDKCode } from "@/lib/workflow/codegen/sdk";

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

    // KEEP-440: code export is unavailable for a soft-deleted workflow.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Generate code
    const code = generateWorkflowSDKCode(
      workflow.name,
      workflow.nodes,
      workflow.edges
    );

    return NextResponse.json({
      code,
      workflowName: workflow.name,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get workflow code",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/code",
        operation: "get",
        ...auditFromAuth(authContext),
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get workflow code",
      },
      { status: 500 }
    );
  }
}
