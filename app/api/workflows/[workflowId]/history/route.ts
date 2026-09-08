import { and, count, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users, workflowHistory, workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { getWorkflowAccess } from "@/lib/workflow/access";

/**
 * Version timeline for a workflow. Any current member of the workflow's org can
 * read it -- it's the edit history of a workflow they already have full access
 * to, not the org-wide security audit (that stays admin/owner only). Returns the
 * lightweight per-version metadata + diff (`change`) for the timeline; the heavy
 * snapshot is fetched on demand via GET /api/workflows/[id]?version=N.
 * `changedBy` is enriched with the actor's name/email so the UI can show "who".
 */
/**
 * Restrict the timeline to versions that touched one node.
 *
 * Mirrors `versionTouchesNode` in the History panel: a node matches by id on
 * the three node buckets, and a connection matches by endpoint id, falling
 * back to the endpoint label for diffs recorded before ids were stored.
 * Keeping the predicate here rather than in the client is what makes the
 * paging honest, since `total` has to count the same rows the page returns.
 */
function nodeScopeFilter(nodeId: string, nodeLabel: string | null): SQL {
  const node = JSON.stringify([{ id: nodeId }]);
  const from = JSON.stringify([{ fromId: nodeId }]);
  const to = JSON.stringify([{ toId: nodeId }]);
  const clauses = [
    sql`${workflowHistory.change}->'nodesAdded' @> ${node}::jsonb`,
    sql`${workflowHistory.change}->'nodesRemoved' @> ${node}::jsonb`,
    sql`${workflowHistory.change}->'nodesChanged' @> ${node}::jsonb`,
    sql`${workflowHistory.change}->'connectionsAdded' @> ${from}::jsonb`,
    sql`${workflowHistory.change}->'connectionsAdded' @> ${to}::jsonb`,
    sql`${workflowHistory.change}->'connectionsRemoved' @> ${from}::jsonb`,
    sql`${workflowHistory.change}->'connectionsRemoved' @> ${to}::jsonb`,
  ];
  if (nodeLabel) {
    // Legacy diffs carry endpoint labels only. Matching those by label is the
    // reason a renamed node does not lose its older connection changes.
    const labelFrom = JSON.stringify([{ from: nodeLabel }]);
    const labelTo = JSON.stringify([{ to: nodeLabel }]);
    clauses.push(
      sql`${workflowHistory.change}->'connectionsAdded' @> ${labelFrom}::jsonb`,
      sql`${workflowHistory.change}->'connectionsAdded' @> ${labelTo}::jsonb`,
      sql`${workflowHistory.change}->'connectionsRemoved' @> ${labelFrom}::jsonb`,
      sql`${workflowHistory.change}->'connectionsRemoved' @> ${labelTo}::jsonb`
    );
  }
  return sql`(${sql.join(clauses, sql` OR `)})`;
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
    if (!(access.hasFullAccess && userId && workflow.organizationId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const req = parsePageRequest(url);
    const nodeId = url.searchParams.get("nodeId");
    const nodeLabel = url.searchParams.get("nodeLabel");
    const where = nodeId
      ? and(
          eq(workflowHistory.workflowId, workflowId),
          nodeScopeFilter(nodeId, nodeLabel)
        )
      : eq(workflowHistory.workflowId, workflowId);

    const [{ total }] = await db
      .select({ total: count() })
      .from(workflowHistory)
      .where(where);

    // Workflows created before versioning have no rows. Synthesize the current
    // state as version 1 so the timeline isn't empty -- the live workflow IS
    // that version, so it reads as the current/initial entry. Skipped when
    // scoped to a node: an empty result there means the node has no recorded
    // changes, and inventing an entry would misreport that.
    if (total === 0 && !nodeId) {
      const [creator] = workflow.userId
        ? await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, workflow.userId))
            .limit(1)
        : [];
      const synthetic = {
        version: 1,
        source: "create" as const,
        contentHash: "",
        previousVersion: null,
        change: null,
        createdAt: workflow.createdAt.toISOString(),
        changedBy:
          creator ?? (workflow.userId ? { id: workflow.userId } : null),
      };
      return NextResponse.json(buildPage([synthetic], 1, req, url));
    }

    const rows = await db
      .select({
        version: workflowHistory.version,
        source: workflowHistory.source,
        contentHash: workflowHistory.contentHash,
        previousVersion: workflowHistory.previousVersion,
        change: workflowHistory.change,
        changedByUserId: workflowHistory.changedByUserId,
        createdAt: workflowHistory.createdAt,
      })
      .from(workflowHistory)
      .where(where)
      .orderBy(desc(workflowHistory.version))
      .limit(req.pageSize)
      .offset(req.offset);

    // Enrich actor ids -> name/email in one lookup so the timeline shows "who".
    const actorIds = [
      ...new Set(rows.map((r) => r.changedByUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, actorIds))
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    const items = rows.map((r) => ({
      version: r.version,
      source: r.source,
      contentHash: r.contentHash,
      previousVersion: r.previousVersion,
      change: r.change,
      createdAt: r.createdAt.toISOString(),
      changedBy: r.changedByUserId
        ? (actorMap.get(r.changedByUserId) ?? { id: r.changedByUserId })
        : null,
    }));

    return NextResponse.json(buildPage(items, total, req, url));
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to read workflow history",
      error,
      { endpoint: "/api/workflows/[workflowId]/history" }
    );
    return NextResponse.json(
      { error: "Failed to read workflow history" },
      { status: 500 }
    );
  }
}
