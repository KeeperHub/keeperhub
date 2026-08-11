import "server-only";

import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { ERROR_STATUSES } from "@/lib/errors/execution-status";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";

export type DigestCadence = "daily" | "weekly" | "monthly";

export const DIGEST_CADENCES: DigestCadence[] = ["daily", "weekly", "monthly"];

// Only owners and admins may subscribe to / receive the digest. Enforced both
// at save time (settings API) and at send time (cron) so a member who was
// subscribed and later downgraded stops receiving emails.
export const SUBSCRIBABLE_ROLES: string[] = ["owner", "admin"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Daily threshold sits below 24h so a cron that fires at a fixed wall-clock time
// each day still sends when the previous send landed a little later. Weekly is
// pinned to Tuesday (below), guarded by "not already sent today".
const DAILY_DUE_THRESHOLD_MS = 23 * HOUR_MS;

// Weekly digests go out on Tuesday (14:00 UTC cron) -- mid-week mornings see
// the best email engagement. 2 = Tuesday in getUTCDay().
const WEEKLY_DIGEST_UTC_DAY = 2;

// Monthly digests go out on the 1st (14:00 UTC cron), reporting the previous
// calendar month so the window lines up with the plan's billing cycle.
const MONTHLY_DIGEST_UTC_DATE = 1;

function isSameUtcDate(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Whether a digest of the given cadence is due now. Daily sends roughly once a
 * day; weekly sends only on Tuesdays (UTC), once per day; monthly sends only on
 * the 1st (UTC), once per day. The cron runs daily at 14:00 UTC, so weekly
 * digests land Tuesday 14:00 UTC and monthly digests land the 1st at 14:00 UTC.
 */
export function isDigestDue(
  cadence: DigestCadence,
  lastSentAt: Date | null,
  now: Date
): boolean {
  if (cadence === "weekly") {
    if (now.getUTCDay() !== WEEKLY_DIGEST_UTC_DAY) {
      return false;
    }
    // Avoid a second send if the cron fires more than once on the same Tuesday.
    return !(lastSentAt && isSameUtcDate(lastSentAt, now));
  }
  if (cadence === "monthly") {
    if (now.getUTCDate() !== MONTHLY_DIGEST_UTC_DATE) {
      return false;
    }
    // Avoid a second send if the cron fires more than once on the same 1st.
    return !(lastSentAt && isSameUtcDate(lastSentAt, now));
  }
  if (!lastSentAt) {
    return true;
  }
  return now.getTime() - lastSentAt.getTime() >= DAILY_DUE_THRESHOLD_MS;
}

export type DigestWindow = { since: Date; until: Date };

/**
 * The [since, until) window a digest of the given cadence should summarize.
 * Daily and weekly are rolling windows ending now; monthly reports the previous
 * full calendar month (UTC) so it aligns with the billing cycle that renews on
 * the 1st.
 */
export function digestWindow(cadence: DigestCadence, now: Date): DigestWindow {
  if (cadence === "monthly") {
    const until = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
    );
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0)
    );
    return { since, until };
  }
  const span = cadence === "daily" ? DAY_MS : 7 * DAY_MS;
  return { since: new Date(now.getTime() - span), until: now };
}

export type FailingWorkflow = {
  workflowId: string;
  name: string;
  failures: number;
  lastError: string | null;
};

export type MostExecutedWorkflow = {
  workflowId: string;
  name: string;
  runs: number;
};

export type OrgExecutionDigest = {
  total: number;
  success: number;
  error: number;
  // Distinct workflows that ran at least once over the window.
  distinctWorkflows: number;
  // On-chain activity over the window.
  transactionCount: number;
  gasUsedWei: string;
  // Present only when gas sponsorship is enabled; otherwise undefined so the
  // email omits the sponsored section entirely.
  sponsoredTransactionCount?: number;
  topFailing: FailingWorkflow[];
  mostExecuted: MostExecutedWorkflow[];
};

const TOP_FAILING_LIMIT = 5;
const TOP_EXECUTED_LIMIT = 3;

/**
 * Aggregate an org's workflow executions over [since, until): run totals,
 * on-chain tx count and gas, the most-executed workflows, the top-failing
 * workflows (with each one's most recent error), and -- when gas sponsorship
 * is enabled -- the sponsored-transaction count.
 */
export async function getOrgExecutionDigest(
  organizationId: string,
  since: Date,
  until: Date
): Promise<OrgExecutionDigest> {
  const windowFilter = and(
    eq(workflows.organizationId, organizationId),
    gte(workflowExecutions.startedAt, since),
    lt(workflowExecutions.startedAt, until)
  );

  const [totalsRow] = await db
    .select({
      total: count(),
      success: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'success' THEN 1 ELSE 0 END)`,
      error: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'error' THEN 1 ELSE 0 END)`,
      distinctWorkflows: sql<number>`COUNT(DISTINCT ${workflowExecutions.workflowId})`,
      transactionCount: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${workflowExecutions.transactionHashes}) = 'array' THEN jsonb_array_length(${workflowExecutions.transactionHashes}) ELSE 0 END), 0)`,
      gasUsedWei: sql<string>`COALESCE(SUM(${workflowExecutions.gasUsedWei}), 0)`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(windowFilter);

  const mostExecutedRows = await db
    .select({
      workflowId: workflows.id,
      name: workflows.name,
      runs: count(),
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(windowFilter)
    .groupBy(workflows.id, workflows.name)
    .orderBy(desc(count()))
    .limit(TOP_EXECUTED_LIMIT);

  const errorFilter = and(
    windowFilter,
    inArray(workflowExecutions.status, [...ERROR_STATUSES])
  );

  const failingRows = await db
    .select({
      workflowId: workflows.id,
      name: workflows.name,
      failures: count(),
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(errorFilter)
    .groupBy(workflows.id, workflows.name)
    .orderBy(desc(count()))
    .limit(TOP_FAILING_LIMIT);

  // Latest error message per failing workflow, in one pass over the window.
  const latestErrorRows = await db
    .selectDistinctOn([workflowExecutions.workflowId], {
      workflowId: workflowExecutions.workflowId,
      error: workflowExecutions.error,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(errorFilter)
    .orderBy(workflowExecutions.workflowId, desc(workflowExecutions.startedAt));

  const lastErrorByWorkflow = new Map<string, string | null>();
  for (const row of latestErrorRows) {
    lastErrorByWorkflow.set(row.workflowId, row.error ?? null);
  }

  // Sponsored-tx count is only meaningful (and only queried) when gas
  // sponsorship is enabled. Sponsored step runs stamp output_raw.sponsored.
  let sponsoredTransactionCount: number | undefined;
  if (isGasSponsorshipEnabled()) {
    const [sponsoredRow] = await db
      .select({ value: count() })
      .from(workflowExecutionLogs)
      .innerJoin(
        workflowExecutions,
        eq(workflowExecutionLogs.executionId, workflowExecutions.id)
      )
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(
        and(
          windowFilter,
          sql`${workflowExecutionLogs.outputRaw}->>'sponsored' = 'true'`
        )
      );
    sponsoredTransactionCount = Number(sponsoredRow?.value) || 0;
  }

  return {
    total: Number(totalsRow?.total) || 0,
    success: Number(totalsRow?.success) || 0,
    error: Number(totalsRow?.error) || 0,
    distinctWorkflows: Number(totalsRow?.distinctWorkflows) || 0,
    transactionCount: Number(totalsRow?.transactionCount) || 0,
    gasUsedWei: totalsRow?.gasUsedWei ?? "0",
    sponsoredTransactionCount,
    topFailing: failingRows.map((row) => ({
      workflowId: row.workflowId,
      name: row.name,
      failures: Number(row.failures) || 0,
      lastError: lastErrorByWorkflow.get(row.workflowId) ?? null,
    })),
    mostExecuted: mostExecutedRows.map((row) => ({
      workflowId: row.workflowId,
      name: row.name,
      runs: Number(row.runs) || 0,
    })),
  };
}
