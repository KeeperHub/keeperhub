import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";
import { classifyExecutionError } from "@/lib/errors/classify";
import {
  recordWorkflowExecutionError,
  recordWorkflowExecutionErrorByWorkflow,
} from "@/lib/metrics/collectors/prometheus";
import { ANONYMOUS_ORG_SLUG } from "@/lib/metrics/db-metrics";

/**
 * Increment `keeperhub_workflow_execution_errors_created_total` after a
 * `workflow_executions` row has been written with status='error'.
 *
 * Resolves the org slug for the workflow so the counter series is scoped
 * for the managed-client SLA alert. Falls back to ANONYMOUS_ORG_SLUG for
 * personal workflows so personal failures still emit a series.
 *
 * Safe to call after the DB write succeeded. Errors are caught and dropped
 * because metric emission must never break an already-finalized execution.
 */
export async function recordExecutionErrorFinalized(args: {
  workflowId: string;
  errorMessage: string | null | undefined;
  errorCategory?: string;
}): Promise<void> {
  try {
    const classification = classifyExecutionError(args.errorMessage);
    const errorCategory = args.errorCategory ?? classification.errorCategory;
    const { errorType } = classification;

    const row = await db
      .select({ slug: organization.slug })
      .from(workflows)
      .leftJoin(organization, eq(workflows.organizationId, organization.id))
      .where(eq(workflows.id, args.workflowId))
      .limit(1);

    const orgSlug = row[0]?.slug ?? ANONYMOUS_ORG_SLUG;

    recordWorkflowExecutionError({
      orgSlug,
      errorCategory,
      errorType,
    });

    recordWorkflowExecutionErrorByWorkflow({
      workflowId: args.workflowId,
      orgSlug,
      errorType,
    });
  } catch {
    // Counter emission must not break the execution finalize path.
  }
}
