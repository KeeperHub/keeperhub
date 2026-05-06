import "server-only";

import { db } from "@/lib/db";
import { directExecutions, workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * Trigger types that produce a workflow_executions row when blocked.
 */
export type WorkflowBlockedTrigger =
  | "manual"
  | "webhook"
  | "mcp"
  | "internal"
  | "schedule"
  | "block"
  | "event";

/**
 * Trigger types that produce a direct_executions row when blocked.
 */
export type DirectBlockedTrigger =
  | "transfer"
  | "contract-call"
  | "check-and-execute"
  | "node";

/**
 * Subset of fields read off the guard's `limitResult` (when blocked). The
 * call sites pass `executionGuard.limitResult` directly; we tolerate missing
 * fields so test mocks that only set `{ blocked: true, response }` do not
 * throw at runtime.
 */
type LimitSummary =
  | {
      debtExecutions?: number;
      plan?: string;
      used?: number;
      limit?: number;
    }
  | null
  | undefined;

type WorkflowBlockedParams = {
  workflowId: string;
  userId: string;
  triggerType: WorkflowBlockedTrigger;
  limitResult: LimitSummary;
  // biome-ignore lint/suspicious/noExplicitAny: trigger inputs vary by trigger type and are stored verbatim
  input?: Record<string, any> | null;
};

type DirectBlockedParams = {
  organizationId: string;
  apiKeyId: string;
  triggerType: DirectBlockedTrigger;
  limitResult: LimitSummary;
  network?: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: input is the redacted request body, structure varies
  input?: Record<string, any> | null;
};

function summarize(limitResult: LimitSummary): {
  reason: string;
  plan: string;
  used: number;
  limit: number;
} {
  const debt = limitResult?.debtExecutions ?? 0;
  return {
    reason: debt > 0 ? "active_debt" : "free_limit_exceeded",
    plan: limitResult?.plan ?? "unknown",
    used: limitResult?.used ?? 0,
    limit: limitResult?.limit ?? 0,
  };
}

function buildErrorMessage(
  reason: string,
  plan: string,
  used: number,
  limit: number
): string {
  return `Billing limit reached: ${reason} (used ${used}/${limit} on ${plan} plan)`;
}

/**
 * Insert a workflow_executions row marking the attempt as blocked by the
 * billing guard. Surfaces the attempt in the workflow's execution history
 * so users can see why their schedule / webhook / manual run did not fire.
 *
 * Count queries in lib/billing/plans-server.ts and the four other read sites
 * exclude `status = 'blocked_billing'`, so these rows do NOT consume tier
 * quota -- otherwise they would self-multiply.
 */
export async function recordBlockedWorkflowExecution(
  params: WorkflowBlockedParams
): Promise<void> {
  const { reason, plan, used, limit } = summarize(params.limitResult);
  try {
    await db.insert(workflowExecutions).values({
      workflowId: params.workflowId,
      userId: params.userId,
      status: "blocked_billing",
      error: buildErrorMessage(reason, plan, used, limit),
      input: params.input ?? undefined,
      completedAt: new Date(),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Billing] Failed to record blocked workflow execution",
      error,
      {
        workflow_id: params.workflowId,
        trigger_type: params.triggerType,
      }
    );
  }
}

/**
 * Same as recordBlockedWorkflowExecution but for the Direct Execution API
 * (which writes to direct_executions, not workflow_executions).
 */
export async function recordBlockedDirectExecution(
  params: DirectBlockedParams
): Promise<void> {
  const { reason, plan, used, limit } = summarize(params.limitResult);
  try {
    await db.insert(directExecutions).values({
      organizationId: params.organizationId,
      apiKeyId: params.apiKeyId,
      type: params.triggerType,
      network: params.network ?? null,
      status: "blocked_billing",
      error: buildErrorMessage(reason, plan, used, limit),
      input: params.input ?? undefined,
      completedAt: new Date(),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Billing] Failed to record blocked direct execution",
      error,
      {
        org_id: params.organizationId,
        trigger_type: params.triggerType,
      }
    );
  }
}
