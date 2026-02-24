import "server-only";

import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  directExecutions,
  organizationSpendCaps,
} from "@/keeperhub/db/schema-extensions";
import { db } from "@/lib/db";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import {
  getBucketInterval,
  getPreviousPeriodStart,
  getTimeRangeStart,
} from "./time-range";
import type {
  AnalyticsSummary,
  NetworkBreakdown,
  NormalizedStatus,
  RunSource,
  StepLog,
  TimeRange,
  TimeSeriesBucket,
  UnifiedRun,
} from "./types";

/**
 * Normalize workflow execution status to a unified status.
 * workflow_executions uses: pending | running | success | error | cancelled
 * direct_executions uses: pending | running | completed | failed
 * We normalize to: pending | running | success | error
 */
function normalizeStatus(status: string, source: RunSource): NormalizedStatus {
  if (source === "direct") {
    if (status === "completed") {
      return "success";
    }
    if (status === "failed") {
      return "error";
    }
  }
  if (status === "cancelled") {
    return "error";
  }
  return status as NormalizedStatus;
}

/**
 * Map a normalized status to the direct_executions DB status values.
 */
function directDbStatuses(status: NormalizedStatus): string[] {
  if (status === "success") {
    return ["completed"];
  }
  if (status === "error") {
    return ["failed"];
  }
  return [status];
}

/**
 * Parse a bucket row into a TimeSeriesBucket.
 */
function parseBucketRow(row: {
  bucket: string;
  success: string;
  error: string;
  pending: string;
  running: string;
}): TimeSeriesBucket {
  return {
    timestamp: new Date(row.bucket).toISOString(),
    success: Number(row.success) || 0,
    error: Number(row.error) || 0,
    pending: Number(row.pending) || 0,
    running: Number(row.running) || 0,
  };
}

/**
 * Merge a parsed bucket into an existing map, summing values.
 */
function addBucketToMap(
  map: Map<string, TimeSeriesBucket>,
  bucket: TimeSeriesBucket
): void {
  const existing = map.get(bucket.timestamp);
  if (existing) {
    existing.success += bucket.success;
    existing.error += bucket.error;
    existing.pending += bucket.pending;
    existing.running += bucket.running;
  } else {
    map.set(bucket.timestamp, { ...bucket });
  }
}

/**
 * Fetch KPI summary for the analytics dashboard.
 */
export async function getAnalyticsSummary(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): Promise<AnalyticsSummary> {
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();

  const [
    workflowStats,
    directStats,
    activeWorkflows,
    activeDirects,
    previousPeriod,
  ] = await Promise.all([
    getWorkflowCounts(organizationId, rangeStart, rangeEnd),
    getDirectCounts(organizationId, rangeStart, rangeEnd),
    getActiveWorkflowCount(organizationId),
    getActiveDirectCount(organizationId),
    getPreviousPeriodSummary(organizationId, range, customStart, customEnd),
  ]);

  const totalRuns = workflowStats.total + directStats.total;
  const successCount = workflowStats.success + directStats.success;
  const errorCount = workflowStats.error + directStats.error;
  const successRate = totalRuns > 0 ? successCount / totalRuns : 0;

  const avgDurationMs = computeAvgDuration(
    workflowStats.durationSum + directStats.durationSum,
    workflowStats.durationCount + directStats.durationCount
  );

  const totalGasWei = directStats.totalGasWei;

  return {
    totalRuns,
    successCount,
    errorCount,
    successRate,
    avgDurationMs,
    totalGasWei,
    activeRuns: activeWorkflows + activeDirects,
    previousPeriod,
  };
}

async function getWorkflowCounts(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<{
  total: number;
  success: number;
  error: number;
  durationSum: number;
  durationCount: number;
}> {
  const result = await db
    .select({
      total: count(),
      success: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} = 'success' THEN 1 ELSE 0 END)`,
      error: sql<number>`SUM(CASE WHEN ${workflowExecutions.status} IN ('error', 'cancelled') THEN 1 ELSE 0 END)`,
      durationSum: sql<number>`COALESCE(SUM(CAST(${workflowExecutions.duration} AS INTEGER)), 0)`,
      durationCount: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        gte(workflowExecutions.startedAt, rangeStart),
        lt(workflowExecutions.startedAt, rangeEnd)
      )
    );

  const row = result[0];
  return {
    total: Number(row?.total) || 0,
    success: Number(row?.success) || 0,
    error: Number(row?.error) || 0,
    durationSum: Number(row?.durationSum) || 0,
    durationCount: Number(row?.durationCount) || 0,
  };
}

async function getDirectCounts(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<{
  total: number;
  success: number;
  error: number;
  durationSum: number;
  durationCount: number;
  totalGasWei: string;
}> {
  const result = await db
    .select({
      total: count(),
      success: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'completed' THEN 1 ELSE 0 END)`,
      error: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'failed' THEN 1 ELSE 0 END)`,
      durationSum: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${directExecutions.completedAt} - ${directExecutions.createdAt})) * 1000), 0)`,
      durationCount: sql<number>`SUM(CASE WHEN ${directExecutions.completedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
      totalGasWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        gte(directExecutions.createdAt, rangeStart),
        lt(directExecutions.createdAt, rangeEnd)
      )
    );

  const row = result[0];
  return {
    total: Number(row?.total) || 0,
    success: Number(row?.success) || 0,
    error: Number(row?.error) || 0,
    durationSum: Number(row?.durationSum) || 0,
    durationCount: Number(row?.durationCount) || 0,
    totalGasWei: row?.totalGasWei ?? "0",
  };
}

function getActiveWorkflowCount(organizationId: string): Promise<number> {
  return db
    .select({ count: count() })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        sql`${workflowExecutions.status} IN ('pending', 'running')`
      )
    )
    .then((r) => Number(r[0]?.count) || 0);
}

function getActiveDirectCount(organizationId: string): Promise<number> {
  return db
    .select({ count: count() })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        sql`${directExecutions.status} IN ('pending', 'running')`
      )
    )
    .then((r) => Number(r[0]?.count) || 0);
}

async function getPreviousPeriodSummary(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): Promise<AnalyticsSummary["previousPeriod"]> {
  const { start, end } = getPreviousPeriodStart(range, customStart, customEnd);

  const [workflowStats, directStats] = await Promise.all([
    getWorkflowCounts(organizationId, start, end),
    getDirectCounts(organizationId, start, end),
  ]);

  return {
    totalRuns: workflowStats.total + directStats.total,
    successCount: workflowStats.success + directStats.success,
    errorCount: workflowStats.error + directStats.error,
    avgDurationMs: computeAvgDuration(
      workflowStats.durationSum + directStats.durationSum,
      workflowStats.durationCount + directStats.durationCount
    ),
    totalGasWei: directStats.totalGasWei,
  };
}

function computeAvgDuration(sum: number, durationCount: number): number | null {
  if (durationCount === 0) {
    return null;
  }
  return Math.round(sum / durationCount);
}

/**
 * Fetch time-series bucketed data for charts.
 */
export async function getTimeSeries(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): Promise<TimeSeriesBucket[]> {
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();
  const { sqlInterval } = getBucketInterval(range);
  const bucketExpr = bucketSql(sqlInterval);

  const workflowBuckets = await db
    .select({
      bucket: sql<string>`${bucketExpr(workflowExecutions.startedAt)}`,
      success: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'success' THEN 1 ELSE 0 END)`,
      error: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} IN ('error', 'cancelled') THEN 1 ELSE 0 END)`,
      pending: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'pending' THEN 1 ELSE 0 END)`,
      running: sql<string>`SUM(CASE WHEN ${workflowExecutions.status} = 'running' THEN 1 ELSE 0 END)`,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        gte(workflowExecutions.startedAt, rangeStart),
        lt(workflowExecutions.startedAt, rangeEnd)
      )
    )
    .groupBy(sql`${bucketExpr(workflowExecutions.startedAt)}`)
    .orderBy(sql`${bucketExpr(workflowExecutions.startedAt)} ASC`);

  const directBuckets = await db
    .select({
      bucket: sql<string>`${bucketExpr(directExecutions.createdAt)}`,
      success: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'completed' THEN 1 ELSE 0 END)`,
      error: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'failed' THEN 1 ELSE 0 END)`,
      pending: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'pending' THEN 1 ELSE 0 END)`,
      running: sql<string>`SUM(CASE WHEN ${directExecutions.status} = 'running' THEN 1 ELSE 0 END)`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        gte(directExecutions.createdAt, rangeStart),
        lt(directExecutions.createdAt, rangeEnd)
      )
    )
    .groupBy(sql`${bucketExpr(directExecutions.createdAt)}`)
    .orderBy(sql`${bucketExpr(directExecutions.createdAt)} ASC`);

  return mergeBuckets(
    workflowBuckets as BucketRow[],
    directBuckets as BucketRow[]
  );
}

/**
 * Build a SQL fragment that truncates a timestamp column to the given bucket interval.
 * Uses date_trunc for standard intervals and integer division for sub-hour buckets.
 */
function bucketSql(
  sqlInterval: string
): (
  col: typeof workflowExecutions.startedAt | typeof directExecutions.createdAt
) => ReturnType<typeof sql> {
  if (sqlInterval === "1 day") {
    return (col) => sql`date_trunc('day', ${col})`;
  }
  if (sqlInterval === "6 hours") {
    return (col) =>
      sql`date_trunc('day', ${col}) + FLOOR(EXTRACT(HOUR FROM ${col}) / 6) * INTERVAL '6 hours'`;
  }
  if (sqlInterval === "5 minutes") {
    return (col) =>
      sql`date_trunc('hour', ${col}) + FLOOR(EXTRACT(MINUTE FROM ${col}) / 5) * 5 * INTERVAL '1 minute'`;
  }
  return (col) => sql`date_trunc('hour', ${col})`;
}

type BucketRow = {
  bucket: string;
  success: string;
  error: string;
  pending: string;
  running: string;
};

function mergeBuckets(
  workflowRows: BucketRow[],
  directRows: BucketRow[]
): TimeSeriesBucket[] {
  const map = new Map<string, TimeSeriesBucket>();

  for (const row of workflowRows) {
    addBucketToMap(map, parseBucketRow(row));
  }

  for (const row of directRows) {
    addBucketToMap(map, parseBucketRow(row));
  }

  return [...map.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}

/**
 * Fetch gas breakdown by network.
 */
export async function getNetworkBreakdown(
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): Promise<NetworkBreakdown[]> {
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();

  const result = await db
    .select({
      network: directExecutions.network,
      totalGasWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
      executionCount: count(),
      successCount: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'completed' THEN 1 ELSE 0 END)`,
      errorCount: sql<number>`SUM(CASE WHEN ${directExecutions.status} = 'failed' THEN 1 ELSE 0 END)`,
    })
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.organizationId, organizationId),
        gte(directExecutions.createdAt, rangeStart),
        lt(directExecutions.createdAt, rangeEnd)
      )
    )
    .groupBy(directExecutions.network)
    .orderBy(sql`SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)) DESC`);

  return result.map((row) => ({
    network: row.network,
    totalGasWei: row.totalGasWei,
    executionCount: Number(row.executionCount),
    successCount: Number(row.successCount),
    errorCount: Number(row.errorCount),
  }));
}

/**
 * Fetch unified runs with cursor-based pagination.
 */
export async function getUnifiedRuns(
  organizationId: string,
  range: TimeRange,
  options: {
    cursor?: string;
    limit?: number;
    status?: NormalizedStatus;
    source?: RunSource;
    customStart?: string;
    customEnd?: string;
  } = {}
): Promise<{ runs: UnifiedRun[]; nextCursor: string | null; total: number }> {
  const {
    cursor,
    limit = 50,
    status,
    source,
    customStart,
    customEnd,
  } = options;
  const rangeStart = getTimeRangeStart(range, customStart);
  const rangeEnd = customEnd ? new Date(customEnd) : new Date();
  const pageLimit = Math.min(limit, 100);

  const workflowRuns =
    source === "direct"
      ? []
      : await fetchWorkflowRuns(
          organizationId,
          rangeStart,
          rangeEnd,
          status,
          cursor,
          pageLimit + 1
        );

  const directRuns =
    source === "workflow"
      ? []
      : await fetchDirectRuns(
          organizationId,
          rangeStart,
          rangeEnd,
          status,
          cursor,
          pageLimit + 1
        );

  const allRuns = [...workflowRuns, ...directRuns].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const hasMore = allRuns.length > pageLimit;
  const pagedRuns = allRuns.slice(0, pageLimit);
  const nextCursor = hasMore ? (pagedRuns.at(-1)?.startedAt ?? null) : null;

  const total = await getUnifiedRunsTotal(
    organizationId,
    rangeStart,
    rangeEnd,
    status,
    source
  );

  return { runs: pagedRuns, nextCursor, total };
}

async function fetchWorkflowRuns(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  cursor: string | undefined,
  limit: number
): Promise<UnifiedRun[]> {
  // Scope to org's workflows via subquery so leftJoin still enforces org isolation
  const orgWorkflowIds = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.organizationId, organizationId));

  const conditions = [
    sql`${workflowExecutions.workflowId} IN (${orgWorkflowIds})`,
    gte(workflowExecutions.startedAt, rangeStart),
    lt(workflowExecutions.startedAt, rangeEnd),
  ];

  if (status) {
    const dbStatuses = status === "error" ? ["error", "cancelled"] : [status];
    conditions.push(
      sql`${workflowExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }

  if (cursor) {
    conditions.push(lt(workflowExecutions.startedAt, new Date(cursor)));
  }

  const result = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      startedAt: workflowExecutions.startedAt,
      completedAt: workflowExecutions.completedAt,
      duration: workflowExecutions.duration,
      workflowId: workflowExecutions.workflowId,
      workflowName: workflows.name,
      totalSteps: workflowExecutions.totalSteps,
      completedSteps: workflowExecutions.completedSteps,
    })
    .from(workflowExecutions)
    .leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(and(...conditions))
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(limit);

  return result.map((row) => ({
    id: row.id,
    source: "workflow" as const,
    status: normalizeStatus(row.status, "workflow"),
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.duration ? Number(row.duration) : null,
    workflowId: row.workflowId,
    workflowName: row.workflowName ?? "(Deleted)",
    directType: null,
    network: null,
    transactionHash: null,
    gasUsedWei: null,
    totalSteps: row.totalSteps ? Number(row.totalSteps) : null,
    completedSteps: row.completedSteps ? Number(row.completedSteps) : null,
  }));
}

async function fetchDirectRuns(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  cursor: string | undefined,
  limit: number
): Promise<UnifiedRun[]> {
  const conditions = [
    eq(directExecutions.organizationId, organizationId),
    gte(directExecutions.createdAt, rangeStart),
    lt(directExecutions.createdAt, rangeEnd),
  ];

  if (status) {
    const dbStatuses = directDbStatuses(status);
    conditions.push(
      sql`${directExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }

  if (cursor) {
    conditions.push(lt(directExecutions.createdAt, new Date(cursor)));
  }

  const result = await db
    .select({
      id: directExecutions.id,
      status: directExecutions.status,
      createdAt: directExecutions.createdAt,
      completedAt: directExecutions.completedAt,
      type: directExecutions.type,
      network: directExecutions.network,
      transactionHash: directExecutions.transactionHash,
      gasUsedWei: directExecutions.gasUsedWei,
    })
    .from(directExecutions)
    .where(and(...conditions))
    .orderBy(desc(directExecutions.createdAt))
    .limit(limit);

  return result.map((row) => ({
    id: row.id,
    source: "direct" as const,
    status: normalizeStatus(row.status, "direct"),
    startedAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.completedAt
      ? row.completedAt.getTime() - row.createdAt.getTime()
      : null,
    workflowId: null,
    workflowName: null,
    directType: row.type as UnifiedRun["directType"],
    network: row.network,
    transactionHash: row.transactionHash,
    gasUsedWei: row.gasUsedWei,
    totalSteps: null,
    completedSteps: null,
  }));
}

async function getWorkflowRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined
): Promise<number> {
  const conditions = [
    eq(workflows.organizationId, organizationId),
    gte(workflowExecutions.startedAt, rangeStart),
    lt(workflowExecutions.startedAt, rangeEnd),
  ];
  if (status) {
    const dbStatuses = status === "error" ? ["error", "cancelled"] : [status];
    conditions.push(
      sql`${workflowExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }
  const result = await db
    .select({ count: count() })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(and(...conditions));
  return Number(result[0]?.count) || 0;
}

async function getDirectRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined
): Promise<number> {
  const conditions = [
    eq(directExecutions.organizationId, organizationId),
    gte(directExecutions.createdAt, rangeStart),
    lt(directExecutions.createdAt, rangeEnd),
  ];
  if (status) {
    const dbStatuses = directDbStatuses(status);
    conditions.push(
      sql`${directExecutions.status} IN (${sql.join(
        dbStatuses.map((s) => sql`${s}`),
        sql`, `
      )})`
    );
  }
  const result = await db
    .select({ count: count() })
    .from(directExecutions)
    .where(and(...conditions));
  return Number(result[0]?.count) || 0;
}

async function getUnifiedRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  status: NormalizedStatus | undefined,
  source: RunSource | undefined
): Promise<number> {
  const workflowTotal =
    source === "direct"
      ? 0
      : await getWorkflowRunsTotal(
          organizationId,
          rangeStart,
          rangeEnd,
          status
        );

  const directTotal =
    source === "workflow"
      ? 0
      : await getDirectRunsTotal(organizationId, rangeStart, rangeEnd, status);

  return workflowTotal + directTotal;
}

/**
 * Fetch step-level logs for a workflow execution.
 */
export async function getStepLogs(
  executionId: string,
  organizationId: string
): Promise<StepLog[]> {
  const result = await db
    .select({
      id: workflowExecutionLogs.id,
      nodeId: workflowExecutionLogs.nodeId,
      nodeName: workflowExecutionLogs.nodeName,
      nodeType: workflowExecutionLogs.nodeType,
      status: workflowExecutionLogs.status,
      startedAt: workflowExecutionLogs.startedAt,
      completedAt: workflowExecutionLogs.completedAt,
      duration: workflowExecutionLogs.duration,
      error: workflowExecutionLogs.error,
      iterationIndex: workflowExecutionLogs.iterationIndex,
      forEachNodeId: workflowExecutionLogs.forEachNodeId,
    })
    .from(workflowExecutionLogs)
    .innerJoin(
      workflowExecutions,
      eq(workflowExecutionLogs.executionId, workflowExecutions.id)
    )
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(
      and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflows.organizationId, organizationId)
      )
    )
    .orderBy(workflowExecutionLogs.startedAt);

  return result.map((row) => ({
    id: row.id,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    nodeType: row.nodeType,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.duration ? Number(row.duration) : null,
    error: row.error,
    iterationIndex: row.iterationIndex,
    forEachNodeId: row.forEachNodeId,
  }));
}

/**
 * Get the spend cap and daily usage for an organization.
 */
export async function getSpendCapData(organizationId: string): Promise<{
  dailyCapWei: string | null;
  dailyUsedWei: string;
}> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [capResult, usageResult] = await Promise.all([
    db
      .select({ dailyCapWei: organizationSpendCaps.dailyCapWei })
      .from(organizationSpendCaps)
      .where(eq(organizationSpendCaps.organizationId, organizationId))
      .limit(1),
    db
      .select({
        totalWei: sql<string>`COALESCE(SUM(CAST(${directExecutions.gasUsedWei} AS NUMERIC)), 0)::text`,
      })
      .from(directExecutions)
      .where(
        and(
          eq(directExecutions.organizationId, organizationId),
          eq(directExecutions.status, "completed"),
          gte(directExecutions.createdAt, todayStart)
        )
      ),
  ]);

  return {
    dailyCapWei: capResult[0]?.dailyCapWei ?? null,
    dailyUsedWei: usageResult[0]?.totalWei ?? "0",
  };
}

/**
 * Get a lightweight checksum for SSE change detection.
 * Returns max timestamps + active count so we know when to push updates.
 */
export async function getAnalyticsChecksum(
  organizationId: string
): Promise<string> {
  const [wfMax, deMax, activeCount] = await Promise.all([
    db
      .select({
        maxStarted: sql<string>`COALESCE(MAX(${workflowExecutions.startedAt}), '1970-01-01')::text`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(eq(workflows.organizationId, organizationId))
      .then((r) => r[0]?.maxStarted ?? ""),
    db
      .select({
        maxCreated: sql<string>`COALESCE(MAX(${directExecutions.createdAt}), '1970-01-01')::text`,
      })
      .from(directExecutions)
      .where(eq(directExecutions.organizationId, organizationId))
      .then((r) => r[0]?.maxCreated ?? ""),
    db
      .select({ count: count() })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(
        and(
          eq(workflows.organizationId, organizationId),
          sql`${workflowExecutions.status} IN ('pending', 'running')`
        )
      )
      .then((r) => Number(r[0]?.count) || 0),
  ]);

  return `${wfMax}|${deMax}|${activeCount}`;
}
