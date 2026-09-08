import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executionDebt, organizationSubscriptions } from "@/lib/db/schema";
import {
  countMonthlyExecutionsForDisplay,
  startOfCurrentMonthUtc,
} from "./execution-limit-core";
import {
  getPlanLimits,
  type PlanLimits,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "./plans";
import { getOrgSubscription } from "./plans-server";
import { buildQuotaStatus, type QuotaStatus } from "./quota-threshold-core";

export {
  buildQuotaStatus,
  crossedQuotaThreshold,
  LOWEST_QUOTA_THRESHOLD,
  QUOTA_THRESHOLDS,
  type QuotaStatus,
  type QuotaThreshold,
} from "./quota-threshold-core";

/**
 * The quota status for one org. Used by the banner endpoint.
 *
 * Reads the display count, which shares the guard's TTL cache but never takes
 * its near-limit re-read: this runs on every dashboard load, and the orgs that
 * would trigger that re-read are exactly the ones this banner keeps in front
 * of. A banner being up to one TTL late costs nothing.
 */
export async function getOrgQuotaStatus(
  organizationId: string,
  now: Date = new Date()
): Promise<QuotaStatus | null> {
  const sub = await getOrgSubscription(organizationId);
  const plan = parsePlanName(sub?.plan);
  const tier = parseTierKey(sub?.tier);

  if (getPlanLimits(plan, tier, sub?.planOverrides).maxExecutionsPerMonth < 0) {
    return null;
  }

  const periodStart = startOfCurrentMonthUtc(now);
  const [used, debtExecutions] = await Promise.all([
    countMonthlyExecutionsForDisplay(db, organizationId, periodStart),
    getActiveDebtForOrg(organizationId),
  ]);

  return buildQuotaStatus({
    organizationId,
    plan,
    tier,
    planOverrides: sub?.planOverrides,
    used,
    debtExecutions,
    now,
  });
}

async function getActiveDebtForOrg(organizationId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${executionDebt.debtExecutions}), 0)::int`,
    })
    .from(executionDebt)
    .where(
      and(
        eq(executionDebt.organizationId, organizationId),
        eq(executionDebt.status, "active")
      )
    );
  return rows[0]?.total ?? 0;
}

type OrgUsageRow = { organizationId: string; used: number };

/**
 * Billable executions this month for every org that ran at least one, in a
 * single aggregate. Orgs with no activity cannot have crossed a threshold, so
 * they never enter the scan.
 */
async function countMonthlyExecutionsByOrg(
  periodStart: Date
): Promise<OrgUsageRow[]> {
  const since = periodStart.toISOString();
  const rows = await db.execute<{ organization_id: string; used: number }>(
    sql`SELECT org_id AS organization_id, SUM(subtotal)::int AS used
          FROM (
            SELECT w.organization_id AS org_id, COUNT(*)::int AS subtotal
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE we.started_at >= ${since}
               AND we.billable = TRUE
             GROUP BY w.organization_id
            UNION ALL
            SELECT de.organization_id AS org_id, COUNT(*)::int AS subtotal
              FROM direct_executions de
             WHERE de.created_at >= ${since}
             GROUP BY de.organization_id
          ) t
         GROUP BY org_id`
  );

  return rows.map((row) => ({
    organizationId: row.organization_id,
    used: row.used,
  }));
}

async function getActiveDebtByOrg(
  organizationIds: string[]
): Promise<Map<string, number>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      organizationId: executionDebt.organizationId,
      total: sql<number>`COALESCE(SUM(${executionDebt.debtExecutions}), 0)::int`,
    })
    .from(executionDebt)
    .where(
      and(
        inArray(executionDebt.organizationId, organizationIds),
        eq(executionDebt.status, "active")
      )
    )
    .groupBy(executionDebt.organizationId);
  return new Map(rows.map((row) => [row.organizationId, row.total]));
}

type SubscriptionRow = {
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null;
};

async function getSubscriptionsByOrg(
  organizationIds: string[]
): Promise<Map<string, SubscriptionRow>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      organizationId: organizationSubscriptions.organizationId,
      plan: organizationSubscriptions.plan,
      tier: organizationSubscriptions.tier,
      planOverrides: organizationSubscriptions.planOverrides,
    })
    .from(organizationSubscriptions)
    .where(inArray(organizationSubscriptions.organizationId, organizationIds));

  return new Map(
    rows.map((row) => [
      row.organizationId,
      {
        plan: parsePlanName(row.plan),
        tier: parseTierKey(row.tier),
        planOverrides: row.planOverrides ?? null,
      },
    ])
  );
}

/**
 * Every org that has reached at least the lowest threshold this month.
 *
 * Three queries regardless of org count: one usage aggregate, one subscription
 * fetch, one debt fetch. An org with no subscription row is on the free plan
 * defaults, which is how a never-subscribed org still gets warned.
 */
export async function findOrgsAtQuotaThreshold(
  now: Date = new Date()
): Promise<QuotaStatus[]> {
  const periodStart = startOfCurrentMonthUtc(now);
  const usage = await countMonthlyExecutionsByOrg(periodStart);
  if (usage.length === 0) {
    return [];
  }

  const organizationIds = usage.map((row) => row.organizationId);
  const [subscriptions, debt] = await Promise.all([
    getSubscriptionsByOrg(organizationIds),
    getActiveDebtByOrg(organizationIds),
  ]);

  const statuses: QuotaStatus[] = [];
  for (const row of usage) {
    const sub = subscriptions.get(row.organizationId);
    const status = buildQuotaStatus({
      organizationId: row.organizationId,
      plan: sub?.plan ?? "free",
      tier: sub?.tier ?? null,
      planOverrides: sub?.planOverrides,
      used: row.used,
      debtExecutions: debt.get(row.organizationId) ?? 0,
      now,
    });
    if (status && status.threshold !== null) {
      statuses.push(status);
    }
  }
  return statuses;
}
