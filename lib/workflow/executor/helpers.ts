import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

/**
 * Get organizationId from executionId
 *
 * Workflow executions are scoped to organizations, not individual users.
 * Reads the run's own `organization_id`, written at insert, and falls back to
 * the workflow join for rows that predate the column.
 *
 * @param executionId - Execution ID (passed via _context in workflow steps)
 * @returns organizationId - Organization that owns the workflow
 * @throws Error if execution not found or workflow has no organization
 */
export async function getOrganizationIdFromExecution(
  executionId: string | undefined
): Promise<string> {
  if (!executionId) {
    throw new Error("Execution ID is required to get organization ID");
  }

  const result = await db
    .select({
      executionOrganizationId: workflowExecutions.organizationId,
      workflowOrganizationId: workflows.organizationId,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  if (result.length === 0) {
    throw new Error(`Execution not found: ${executionId}`);
  }

  const { executionOrganizationId, workflowOrganizationId } = result[0];
  const organizationId = executionOrganizationId ?? workflowOrganizationId;

  if (!organizationId) {
    throw new Error(
      "Workflow has no organization. This workflow may be from an anonymous user or migration is incomplete."
    );
  }

  return organizationId;
}
