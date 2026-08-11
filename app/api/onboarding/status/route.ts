import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  integrations,
  organizationApiKeys,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";

/**
 * GET /api/onboarding/status[?workflowIds=a,b,c]
 *
 * Real-state completion signals for the getting-started launcher (KEEP-878).
 * Each is an org-scoped existence check, so an outcome step only turns green
 * once the user has actually done it.
 *
 * `workflowIds` are the drafts/clones the launcher itself created for its "run
 * a workflow" / "pick a starter" steps. We return:
 *   - `executedWorkflowIds`: the subset that has at least one execution, so a
 *     step completes when *that* workflow has been run, never because some
 *     other pre-existing workflow in the org has historical runs.
 *   - `existingWorkflowIds`: the subset that still exists (not deleted) in the
 *     org, so the launcher can tell a live clone from a stale localStorage
 *     pointer to a workflow that was since deleted.
 * Informational steps ("open your wallet") complete client-side and are not
 * reported here.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authCtx = await resolveOrganizationId(request);
  if ("error" in authCtx) {
    return NextResponse.json(
      { error: authCtx.error },
      { status: authCtx.status }
    );
  }
  const orgId = authCtx.organizationId;

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("workflowIds");
  const workflowIds = idsParam
    ? idsParam.split(",").filter((id) => id.length > 0)
    : [];

  const [apiKey, integration, executed, existing] = await Promise.all([
    db
      .select({ one: sql<number>`1` })
      .from(organizationApiKeys)
      .where(
        and(
          eq(organizationApiKeys.organizationId, orgId),
          isNull(organizationApiKeys.revokedAt)
        )
      )
      .limit(1),
    db
      .select({ one: sql<number>`1` })
      .from(integrations)
      .where(
        and(
          eq(integrations.organizationId, orgId),
          ne(integrations.type, "web3")
        )
      )
      .limit(1),
    workflowIds.length === 0
      ? Promise.resolve([] as { workflowId: string }[])
      : db
          .selectDistinct({ workflowId: workflowExecutions.workflowId })
          .from(workflowExecutions)
          .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
          .where(
            and(
              eq(workflows.organizationId, orgId),
              inArray(workflowExecutions.workflowId, workflowIds)
            )
          ),
    workflowIds.length === 0
      ? Promise.resolve([] as { id: string }[])
      : db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, orgId),
              inArray(workflows.id, workflowIds),
              isNull(workflows.deletedAt)
            )
          ),
  ]);

  return NextResponse.json({
    hasApiKey: apiKey.length > 0,
    hasIntegration: integration.length > 0,
    executedWorkflowIds: executed.map((row) => row.workflowId),
    existingWorkflowIds: existing.map((row) => row.id),
  });
}
