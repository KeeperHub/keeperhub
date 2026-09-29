import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { db } from "@/lib/db";
import { workflowExecutions, workflowHistory, workflows } from "@/lib/db/schema";
import { parsePageLimit } from "@/lib/pagination";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { boundedJsonb } from "@/lib/workflow/bounded-jsonb";
import {
  decodeExecutionsCursor,
  encodeExecutionsCursor,
  type ExecutionsCursor,
} from "@/lib/workflow/executions-cursor";
import {
  executionLogNotDeleted,
  executionLogSoftDeleteValues,
} from "@/lib/workflow/soft-delete";

const SUMMARY_DEFAULT_LIMIT = 20;
const SUMMARY_MAX_LIMIT = 100;
/** `total` is exact up to this many live runs and reported as this beyond. */
export const MAX_COUNTED_RUNS = 10_000;
const WEAK_ETAG_PREFIX_RE = /^W\//;

function parseIntOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Resolve the workflow version each run executed: the run carries the
 * content hash of the definition it ran (executed_workflow_hash), which
 * joins to workflow_history.content_hash. Looked up in one batched query.
 */
async function buildRanVersionResolver(
  workflowId: string,
  executions: Array<{ executedWorkflowHash: string | null }>
): Promise<(hash: string | null, startedAt: Date | null) => number | null> {
  const ranHashes = [
    ...new Set(executions.map((e) => e.executedWorkflowHash).filter(Boolean)),
  ] as string[];
  const historyRows =
    ranHashes.length > 0
      ? await db
          .select({
            version: workflowHistory.version,
            contentHash: workflowHistory.contentHash,
            createdAt: workflowHistory.createdAt,
          })
          .from(workflowHistory)
          .where(
            and(
              eq(workflowHistory.workflowId, workflowId),
              inArray(workflowHistory.contentHash, ranHashes)
            )
          )
      : [];
  // A content hash usually maps to exactly one version; a revert can make two
  // versions share it. In that case pick the version that was in effect when
  // the run started (the highest version created at or before startedAt).
  return (hash: string | null, startedAt: Date | null): number | null => {
    if (!hash) {
      return null;
    }
    const candidates = historyRows.filter((h) => h.contentHash === hash);
    if (candidates.length <= 1) {
      return candidates[0]?.version ?? null;
    }
    const at = startedAt ?? new Date(0);
    const eligible = candidates.filter((c) => c.createdAt <= at);
    const pool = eligible.length > 0 ? eligible : candidates;
    return pool.reduce((best, c) => (c.version > best.version ? c : best))
      .version;
  };
}

/**
 * Weak entity-tag comparison (RFC 9110 section 8.8.3.2): `W/` prefixes are
 * ignored on both sides, the header may list several tags, and `*` matches
 * any current representation.
 */
function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null) {
    return false;
  }
  const normalize = (tag: string): string =>
    tag.trim().replace(WEAK_ETAG_PREFIX_RE, "");
  const wanted = normalize(etag);
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || normalize(trimmed) === wanted;
  });
}

type SummaryQuery = { limit: number; cursor: ExecutionsCursor | null };

function parseSummaryQuery(
  searchParams: URLSearchParams
): SummaryQuery | { error: string } {
  const limit = parsePageLimit(searchParams.get("limit"), {
    fallback: SUMMARY_DEFAULT_LIMIT,
    max: SUMMARY_MAX_LIMIT,
  });
  const rawCursor = searchParams.get("cursor");
  if (rawCursor === null) {
    return { limit, cursor: null };
  }
  const cursor = decodeExecutionsCursor(rawCursor);
  if (cursor === null) {
    return { error: "Invalid cursor" };
  }
  return { limit, cursor };
}

/**
 * `view=summary`: the runs list without each run's `input`, `output` and
 * `executionTrace`, paged by a keyset cursor.
 *
 * The full response carries every run's whole output. A single run whose
 * step returned a large body makes that response, and the memory needed to
 * serialise it, as large as the body, and the runs panel re-requests it
 * every couple of seconds. The panel only ever reads status and progress from
 * this list (step data comes from the per-execution logs route), so it uses
 * this view and leaves the full shape to API clients.
 *
 * Ordering is (started_at DESC, id DESC) so the cursor's row-value comparison
 * resumes exactly after the last row even when two runs share a timestamp.
 * One extra row is fetched to learn whether another page exists.
 *
 * The response carries a weak ETag with `Cache-Control: private, no-cache`:
 * the browser stores the page but revalidates on every poll, so an unchanged
 * page costs a 304 with no body.
 */
async function summaryResponse(
  request: Request,
  workflowId: string,
  { limit, cursor }: SummaryQuery
): Promise<NextResponse> {
  const scope = and(
    eq(workflowExecutions.workflowId, workflowId),
    isNull(workflowExecutions.deletedAt)
  );
  const where =
    cursor === null
      ? scope
      : and(
          scope,
          sql`(${workflowExecutions.startedAt}, ${workflowExecutions.id}) < (${cursor.startedAt}::timestamp, ${cursor.id})`
        );

  // The count runs on every poll and no index carries deleted_at, so each
  // live row costs a heap visit. Counting a bounded subquery keeps that cost
  // flat for a workflow with a very long history; past the bound the total is
  // reported as the bound.
  const countedRuns = db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(scope)
    .limit(MAX_COUNTED_RUNS + 1)
    .as("counted_runs");

  const [rows, [{ total: countedTotal }]] = await Promise.all([
    db.query.workflowExecutions.findMany({
      where,
      columns: { input: false, output: false, executionTrace: false },
      extras: {
        // A fixed rendering with the microseconds a JS Date would round away;
        // the cursor is built from it, not from startedAt. to_char rather than
        // ::text so the format does not follow the session's DateStyle.
        startedAtKey:
          sql<string>`to_char(${workflowExecutions.startedAt}, 'YYYY-MM-DD HH24:MI:SS.US')`.as(
            "started_at_key"
          ),
      },
      orderBy: [desc(workflowExecutions.startedAt), desc(workflowExecutions.id)],
      limit: limit + 1,
    }),
    db.select({ total: count() }).from(countedRuns),
  ]);
  const total = Math.min(countedTotal, MAX_COUNTED_RUNS);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeExecutionsCursor({ startedAt: last.startedAtKey, id: last.id })
      : null;

  const resolveVersion = await buildRanVersionResolver(workflowId, pageRows);
  const executions = pageRows.map(
    // biome-ignore lint/correctness/noUnusedVariables: destructure-to-omit pattern
    ({ startedAtKey: _startedAtKey, ...execution }) => ({
      ...execution,
      totalSteps: parseIntOrNull(execution.totalSteps),
      completedSteps: parseIntOrNull(execution.completedSteps),
      ranVersion: resolveVersion(
        execution.executedWorkflowHash,
        execution.startedAt
      ),
    })
  );

  const body = JSON.stringify({ executions, nextCursor, total });
  const etag = `W/"${createHash("sha256").update(body).digest("base64url")}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(body, {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }
    const { userId, organizationId } = authContext;

    const { searchParams } = new URL(request.url);
    const view = searchParams.get("view");
    if (view !== null && view !== "summary") {
      return NextResponse.json(
        { error: 'view must be "summary"' },
        { status: 400 }
      );
    }
    const summaryQuery = view === "summary" ? parseSummaryQuery(searchParams) : null;
    if (summaryQuery !== null && "error" in summaryQuery) {
      return NextResponse.json({ error: summaryQuery.error }, { status: 400 });
    }

    // Verify workflow access (owner or org member)
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: execution history is hidden once the workflow is soft-deleted.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (summaryQuery !== null) {
      return await summaryResponse(request, workflowId, summaryQuery);
    }

    // Fetch executions, excluding runs whose history was purged. A run's
    // input and output come back as a truncated marker past the stored-output
    // limit, so one oversized run cannot size the whole response.
    const executions = await db.query.workflowExecutions.findMany({
      where: and(
        eq(workflowExecutions.workflowId, workflowId),
        isNull(workflowExecutions.deletedAt)
      ),
      columns: { input: false, output: false },
      extras: {
        input: boundedJsonb(workflowExecutions.input).as("input"),
        output: boundedJsonb(workflowExecutions.output).as("output"),
      },
      orderBy: [desc(workflowExecutions.startedAt)],
      limit: 50,
    });

    const resolveVersion = await buildRanVersionResolver(
      workflowId,
      executions
    );

    // KEEP-481: `total_steps` and `completed_steps` are stored as TEXT and
    // Drizzle returns them as strings, which leaks into the response as
    // string-or-null and breaks type-checked SDK clients (Pydantic, Zod, Go).
    // Coerce to `number | null` before serializing so the response matches the
    // numeric shape clients expect; non-numeric strings (shouldn't happen) fall
    // through as null rather than NaN.
    const serialized = executions.map((execution) => ({
      ...execution,
      totalSteps: parseIntOrNull(execution.totalSteps),
      completedSteps: parseIntOrNull(execution.completedSteps),
      ranVersion: resolveVersion(
        execution.executedWorkflowHash,
        execution.startedAt
      ),
    }));

    return NextResponse.json(serialized);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get executions", error, {
      endpoint: "/api/workflows/[workflowId]/executions",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get executions",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { userId, organizationId } = authContext;

    // Verify workflow access (owner or org member)
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: execution history is hidden once the workflow is soft-deleted.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Only the runs not already purged; keeps deletedCount accurate on re-runs.
    const executions = await db.query.workflowExecutions.findMany({
      where: and(
        eq(workflowExecutions.workflowId, workflowId),
        isNull(workflowExecutions.deletedAt)
      ),
      columns: { id: true },
    });

    const executionIds = executions.map((e) => e.id);

    if (executionIds.length > 0) {
      const { workflowExecutionLogs } = await import("@/lib/db/schema");
      const purgedAt = new Date();

      // Soft-delete the per-step logs. They carry the per-network gas the
      // analytics breakdown aggregates, so erasing them leaves a gap the
      // org-level total does not share and nothing can reconcile.
      await db
        .update(workflowExecutionLogs)
        .set(executionLogSoftDeleteValues(purgedAt))
        .where(
          and(
            inArray(workflowExecutionLogs.executionId, executionIds),
            executionLogNotDeleted()
          )
        );

      // Soft-delete the runs themselves: usage counters count every row, so the
      // billing total cannot be reset by purging history. Listings filter
      // deleted_at IS NULL.
      await db
        .update(workflowExecutions)
        .set({ deletedAt: purgedAt })
        .where(inArray(workflowExecutions.id, executionIds));
    }

    return NextResponse.json({
      success: true,
      deletedCount: executionIds.length,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to delete executions",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/executions",
        operation: "delete",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete executions",
      },
      { status: 500 }
    );
  }
}
