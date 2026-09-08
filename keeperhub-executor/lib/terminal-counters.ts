import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { organization, workflows } from "../../lib/db/schema";
import { classifyExecutionError } from "../../lib/errors/classify";
import type { ExecutionErrorType } from "../../lib/errors/execution-error-type";
import type { ErrorStatus } from "../../lib/errors/execution-status";
import { NA_ERROR_TYPE } from "../../lib/metrics/metric-constants";
import { resolveOrgSlugCached } from "../../lib/metrics/org-slug-cache";
import type { DbSchema } from "./db-helpers";

/**
 * Emit the terminal workflow counters for an executor-side terminal write
 * (consumer-crash backstop, billing block, engine-write-lost backstop).
 * These writes happen outside logWorkflowCompleteDb/recordExecutionErrorFinalized,
 * so without this the executions they finalize are invisible to the
 * success-rate SLI. Callers must only invoke it when their compare-and-set
 * actually flipped a non-terminal row, which preserves the emit-once
 * contract. Never throws: metric emission must not break executor DB writes.
 */
/**
 * Emit the refusal counter for a run the platform declined before it started.
 * Deliberately not recordTerminalSample: a refused run is not a failure, so it
 * must stay out of the error series and the success-rate SLI, while still being
 * visible in Prometheus. Never throws, same contract as recordTerminalSample.
 */
export async function recordSkippedSample(
  db: PostgresJsDatabase<DbSchema>,
  args: { workflowId: string; reason: string }
): Promise<void> {
  try {
    const { recordWorkflowExecutionSkipped } = await import(
      "../../lib/metrics/collectors/prometheus"
    );
    const orgSlug = await resolveOrgSlugCached(args.workflowId, (id) =>
      db
        .select({ slug: organization.slug })
        .from(workflows)
        .leftJoin(organization, eq(workflows.organizationId, organization.id))
        .where(eq(workflows.id, id))
        .limit(1)
    );
    recordWorkflowExecutionSkipped({ orgSlug, reason: args.reason });
  } catch {
    // Metric emission must never break the executor's DB writes.
  }
}

export async function recordTerminalSample(
  db: PostgresJsDatabase<DbSchema>,
  args: {
    workflowId: string;
    status: "success" | ErrorStatus;
    errorMessage?: string | null;
    errorType?: ExecutionErrorType;
    errorCategory?: string;
  }
): Promise<void> {
  try {
    // Deferred so importing this module (and db-helpers) never pulls in the
    // prometheus collector's "server-only" guard at load time - same pattern
    // as metrics-shipping.ts. The Docker images shim server-only, but vitest
    // and any non-shimmed context would throw on a static import.
    const {
      recordWorkflowExecutionError,
      recordWorkflowExecutionErrorByWorkflow,
      recordWorkflowExecutionFinished,
    } = await import("../../lib/metrics/collectors/prometheus");

    const orgSlug = await resolveOrgSlugCached(args.workflowId, (id) =>
      db
        .select({ slug: organization.slug })
        .from(workflows)
        .leftJoin(organization, eq(workflows.organizationId, organization.id))
        .where(eq(workflows.id, id))
        .limit(1)
    );

    if (args.status === "success") {
      recordWorkflowExecutionFinished({
        status: "success",
        orgSlug,
        errorType: NA_ERROR_TYPE,
      });
      return;
    }

    const classification = classifyExecutionError(args.errorMessage);
    const errorType = args.errorType ?? classification.errorType;
    const errorCategory = args.errorCategory ?? classification.errorCategory;

    recordWorkflowExecutionError({ orgSlug, errorCategory, errorType });
    recordWorkflowExecutionErrorByWorkflow({
      workflowId: args.workflowId,
      orgSlug,
      errorType,
    });
    recordWorkflowExecutionFinished({
      status: args.status,
      orgSlug,
      errorType,
    });
  } catch {
    // Counter emission must never break the executor's terminal writes.
  }
}
