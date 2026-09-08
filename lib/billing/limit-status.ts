import "server-only";

import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { getPlanLimits, parsePlanName, parseTierKey } from "./plans";
import { getOrgSubscription } from "./plans-server";

function getStartOfMonthUtc(): Date {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  return startOfMonth;
}

async function countEnabledWorkflows(organizationId: string): Promise<number> {
  const result = await db
    .select({ value: count() })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        eq(workflows.enabled, true)
      )
    );
  return result[0]?.value ?? 0;
}

async function getCurrentMonthUsage(organizationId: string): Promise<number> {
  const startOfMonth = getStartOfMonthUtc().toISOString();
  const result = await db.execute<{ count: number }>(
    sql`SELECT
          (
            SELECT COUNT(*)
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${startOfMonth}
               AND we.status <> 'blocked_billing'
               AND we.billable = TRUE
          )
          +
          (
            SELECT COUNT(*)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${startOfMonth}
               AND de.status <> 'blocked_billing'
          ) AS count`
  );
  return result[0]?.count ?? 0;
}

export async function isBillingLimitReached(
  organizationId: string
): Promise<boolean> {
  try {
    const sub = await getOrgSubscription(organizationId);
    const plan = parsePlanName(sub?.plan);
    const tier = parseTierKey(sub?.tier);
    const limits = getPlanLimits(plan, tier, sub?.planOverrides);

    if (limits.maxExecutionsPerMonth < 0) {
      return false;
    }

    const enabledWorkflows = await countEnabledWorkflows(organizationId);
    if (enabledWorkflows === 0) {
      return false;
    }

    const used = await getCurrentMonthUsage(organizationId);
    return used >= limits.maxExecutionsPerMonth;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[limit-status] isBillingLimitReached failed; treating as not-reached",
      error
    );
    return false;
  }
}
