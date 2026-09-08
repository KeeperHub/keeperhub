import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import {
  type PinDataNode,
  type WorkflowNodeLike,
  preparePinDataForWorkflow,
} from "@/lib/mcp/prepare-test-pin-data";
import { getWorkflowAccess } from "@/lib/workflow/access";

/**
 * GET /api/workflows/[workflowId]/test-pins/prepare
 *
 * TESTWF-05: returns the pin data JSON Schema for each node in the
 * workflow. Org-gated read. Introspection ONLY — does NOT execute any
 * plugin step, does NOT write to the database.
 *
 * Response envelope mirrors /api/workflows/[workflowId]/validate:
 *   200 { ok: true, result: { nodes: PinDataNode[] } }
 *   401 { ok: false, error: "Unauthorized" }
 *   403 { ok: false, error: "FORBIDDEN" }
 *   404 { ok: false, error: "NOT_FOUND" }
 *   410 { ok: false, error: "GONE" }
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  const { workflowId } = await context.params;

  const authContext = await getDualAuthContext(request, { required: true });
  if ("error" in authContext) {
    return NextResponse.json(
      { ok: false, error: authContext.error },
      { status: authContext.status }
    );
  }

  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const row = rows[0];

  const access = await getWorkflowAccess(row, {
    userId: authContext.userId,
    organizationId: authContext.organizationId,
    authMethod: authContext.authMethod,
  });

  if (access.isDeleted) {
    return NextResponse.json({ ok: false, error: "GONE" }, { status: 410 });
  }

  if (!access.hasFullAccess) {
    return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
  }

  const nodes: PinDataNode[] = preparePinDataForWorkflow(
    // biome-ignore lint/suspicious/noExplicitAny: workflows.nodes column is jsonb typed as any[]
    ((row.nodes ?? []) as any[]) as WorkflowNodeLike[]
  );

  return NextResponse.json({ ok: true, result: { nodes } });
}
