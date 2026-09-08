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

/**
 * Resolve the execution's audit userId (the workflow's createdBy). Live use:
 * the generated web3 read steps (plugins/web3/steps/*, emitted into
 * lib/workflow/codegen/registry.ts) look up that user's RPC preferences.
 * This is NOT an authority signal - quotas, billing, and credentials key on
 * the owning org via getOrganizationIdFromExecution. Follow-up: move RPC
 * preferences to the org so this helper can be retired.
 */
export async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string> {
  if (!executionId) {
    throw new Error("Execution ID is required to get user ID");
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  if (execution.length === 0) {
    throw new Error(`Execution not found: ${executionId}`);
  }

  return execution[0].userId;
}

/**
 * Lenient variant of getUserIdFromExecution for per-user RPC preference
 * lookups in read steps. RPC preferences are a per-user convenience, not an
 * authority signal, so a missing context, an unknown execution, or a
 * transient DB failure all resolve to undefined and the step falls back to
 * the chain's default RPC config rather than failing. Same retirement note
 * as above: once RPC preferences move to the org this helper goes with them.
 */
export async function getRpcPreferenceUserId(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }
  try {
    const execution = await db
      .select({ userId: workflowExecutions.userId })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .limit(1);
    return execution[0]?.userId;
  } catch {
    return;
  }
}
