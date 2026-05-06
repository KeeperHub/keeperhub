import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  getPlanLimits,
  PLANS,
  type PlanName,
  parsePlanName,
  parseTierKey,
} from "../lib/billing/plans";
import {
  directExecutions,
  executionDebt,
  organizationSubscriptions,
  workflowExecutions,
  workflows,
} from "../lib/db/schema";

const MINIMUM_EXECUTION_FLOOR = 100;

export type BillingGuardResult =
  | {
      allowed: true;
      reason:
        | "billing_disabled"
        | "no_org"
        | "unlimited"
        | "within_limit"
        | "overage_billed";
    }
  | {
      allowed: false;
      reason: "free_limit_exceeded" | "inactive_subscription" | "active_debt";
      plan: PlanName;
      used: number;
      limit: number;
      debtExecutions: number;
      effectiveLimit: number;
    };

function isBillingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";
}

/**
 * Mirrors lib/billing/plans-server.ts#checkExecutionLimit but without the
 * `import "server-only"` constraint so it can run in the standalone executor
 * process. The result determines whether a workflow execution row should be
 * created for an SQS-triggered run (schedule, block, event).
 */
export async function checkExecutionLimitForExecutor(
  db: PostgresJsDatabase<Record<string, unknown>>,
  organizationId: string | null | undefined
): Promise<BillingGuardResult> {
  if (!isBillingEnabled()) {
    return { allowed: true, reason: "billing_disabled" };
  }

  if (!organizationId) {
    return { allowed: true, reason: "no_org" };
  }

  const [sub] = await db
    .select({
      plan: organizationSubscriptions.plan,
      tier: organizationSubscriptions.tier,
      status: organizationSubscriptions.status,
      planOverrides: organizationSubscriptions.planOverrides,
    })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, organizationId))
    .limit(1);

  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);
  const limits = getPlanLimits(plan, tier, sub?.planOverrides);
  const planDef = PLANS[plan];

  if (limits.maxExecutionsPerMonth === -1) {
    return { allowed: true, reason: "unlimited" };
  }

  const debtRows = await db
    .select({ debt: executionDebt.debtExecutions })
    .from(executionDebt)
    .where(
      and(
        eq(executionDebt.organizationId, organizationId),
        eq(executionDebt.status, "active")
      )
    );
  const debtExecutions = debtRows.reduce((sum, r) => sum + (r.debt ?? 0), 0);
  const effectiveLimit = Math.max(
    MINIMUM_EXECUTION_FLOOR,
    limits.maxExecutionsPerMonth - debtExecutions
  );

  if (debtExecutions > 0 && planDef.overage.enabled) {
    return {
      allowed: false,
      reason: "active_debt",
      plan,
      used: 0,
      limit: limits.maxExecutionsPerMonth,
      debtExecutions,
      effectiveLimit,
    };
  }

  const now = new Date();
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  const [workflowCountRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        sql`${workflowExecutions.startedAt} >= ${startOfMonth.toISOString()}`,
        sql`${workflowExecutions.status} <> 'blocked_billing'`
      )
    );

  const [directCountRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        sql`${directExecutions.createdAt} >= ${startOfMonth.toISOString()}`,
        sql`${directExecutions.status} <> 'blocked_billing'`
      )
    );

  const used = (workflowCountRow?.count ?? 0) + (directCountRow?.count ?? 0);

  if (used < limits.maxExecutionsPerMonth) {
    return { allowed: true, reason: "within_limit" };
  }

  if (planDef.overage.enabled && sub?.status === "active") {
    return { allowed: true, reason: "overage_billed" };
  }

  return {
    allowed: false,
    reason: "free_limit_exceeded",
    plan,
    used,
    limit: limits.maxExecutionsPerMonth,
    debtExecutions,
    effectiveLimit,
  };
}

/**
 * Insert a workflow_executions row marking the SQS-triggered attempt as
 * blocked by the billing guard so users can see why their schedule, block,
 * or event trigger did not fire. Mirrors lib/billing/record-blocked-execution.ts
 * but does not import "server-only" so it runs in the standalone executor.
 *
 * Count queries (in plans-server.ts and the four other read sites) exclude
 * `status = 'blocked_billing'`, so these rows do NOT consume tier quota --
 * otherwise they would self-multiply.
 */
export async function recordBlockedWorkflowExecutionForExecutor(
  db: PostgresJsDatabase<Record<string, unknown>>,
  params: {
    workflowId: string;
    userId: string;
    triggerType: "schedule" | "block" | "event";
    reason: string;
    plan: string;
    used: number;
    limit: number;
    input?: Record<string, unknown> | null;
  }
): Promise<void> {
  const errorMessage = `Billing limit reached: ${params.reason} (used ${params.used}/${params.limit} on ${params.plan} plan)`;
  await db.insert(workflowExecutions).values({
    workflowId: params.workflowId,
    userId: params.userId,
    status: "blocked_billing",
    error: errorMessage,
    input: params.input ?? undefined,
    completedAt: new Date(),
  });
}
