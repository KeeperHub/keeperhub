import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { PlanName } from "@/lib/billing/plans";
import { db } from "@/lib/db";
import {
  publicTags,
  workflowPublicTags,
  workflowRatings,
  workflows,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import {
  type PublicFeedEdge,
  type PublicFeedNode,
  projectEdgesForPublicFeed,
  projectNodesForPublicFeed,
} from "@/lib/workflow/public-feed-projection";
import { workflowRequiredPlan } from "@/lib/features/template-plan-gate";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
type TagInfo = { id: string; name: string; slug: string };

async function resolveTagFilter(tagSlug: string): Promise<string[] | "empty"> {
  const tag = await db.query.publicTags.findFirst({
    where: eq(publicTags.slug, tagSlug),
  });

  if (!tag) {
    return "empty";
  }

  const taggedRows = await db
    .select({ workflowId: workflowPublicTags.workflowId })
    .from(workflowPublicTags)
    .where(eq(workflowPublicTags.publicTagId, tag.id));

  const ids = taggedRows.map((r) => r.workflowId);
  return ids.length === 0 ? "empty" : ids;
}

async function fetchTagsByWorkflow(
  workflowIds: string[]
): Promise<Record<string, TagInfo[]>> {
  if (workflowIds.length === 0) {
    return {};
  }

  const tagJoins = await db
    .select({
      workflowId: workflowPublicTags.workflowId,
      tagId: publicTags.id,
      tagName: publicTags.name,
      tagSlug: publicTags.slug,
    })
    .from(workflowPublicTags)
    .innerJoin(publicTags, eq(publicTags.id, workflowPublicTags.publicTagId))
    .where(inArray(workflowPublicTags.workflowId, workflowIds));

  const result: Record<string, TagInfo[]> = {};
  for (const row of tagJoins) {
    if (!result[row.workflowId]) {
      result[row.workflowId] = [];
    }
    result[row.workflowId].push({
      id: row.tagId,
      name: row.tagName,
      slug: row.tagSlug,
    });
  }
  return result;
}

async function fetchScores(
  workflowIds: string[]
): Promise<Record<string, number>> {
  if (workflowIds.length === 0) return {};

  const rows = await db
    .select({
      workflowId: workflowRatings.workflowId,
      score: sql<string>`COALESCE(SUM(${workflowRatings.rating}), 0)`,
    })
    .from(workflowRatings)
    .where(inArray(workflowRatings.workflowId, workflowIds))
    .groupBy(workflowRatings.workflowId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.workflowId] = Number(row.score);
  }
  return result;
}

async function fetchUserVotes(
  userId: string,
  workflowIds: string[]
): Promise<Record<string, VoteDirection>> {
  if (workflowIds.length === 0) return {};

  const rows = await db
    .select({
      workflowId: workflowRatings.workflowId,
      rating: workflowRatings.rating,
    })
    .from(workflowRatings)
    .where(
      and(
        eq(workflowRatings.userId, userId),
        inArray(workflowRatings.workflowId, workflowIds)
      )
    );

  const result: Record<string, VoteDirection> = {};
  for (const row of rows) {
    result[row.workflowId] = row.rating === 1 ? "upvote" : "downvote";
  }
  return result;
}

async function fetchDuplicateCounts(
  workflowIds: string[]
): Promise<Record<string, number>> {
  if (workflowIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({
      sourceWorkflowId: workflows.sourceWorkflowId,
      count: sql<string>`COUNT(*)`,
    })
    .from(workflows)
    .where(
      and(
        inArray(workflows.sourceWorkflowId, workflowIds),
        workflowNotDeleted()
      )
    )
    .groupBy(workflows.sourceWorkflowId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.sourceWorkflowId) {
      result[row.sourceWorkflowId] = Number(row.count);
    }
  }
  return result;
}

async function fetchUserDuplications(
  userId: string,
  workflowIds: string[]
): Promise<Set<string>> {
  if (workflowIds.length === 0) return new Set();

  const rows = await db
    .select({ sourceWorkflowId: workflows.sourceWorkflowId })
    .from(workflows)
    .where(
      and(
        eq(workflows.userId, userId),
        inArray(workflows.sourceWorkflowId, workflowIds),
        workflowNotDeleted()
      )
    );

  const result = new Set<string>();
  for (const row of rows) {
    if (row.sourceWorkflowId) {
      result.add(row.sourceWorkflowId);
    }
  }
  return result;
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const isFeaturedRequest = searchParams.get("featured") === "true";
    const featuredProtocol = searchParams.get("featuredProtocol");
    const tagSlug = searchParams.get("tag");
    let workflowIdFilter: string[] | null = null;

    if (tagSlug) {
      const result = await resolveTagFilter(tagSlug);
      if (result === "empty") {
        return NextResponse.json([]);
      }
      workflowIdFilter = result;
    }

    const isProtocolFeaturedRequest = Boolean(featuredProtocol);

    // KEEP-440: soft-deleted workflows must never surface in the public feed.
    const conditions = [
      eq(workflows.visibility, "public"),
      workflowNotDeleted(),
    ];

    if (isProtocolFeaturedRequest) {
      conditions.push(
        eq(workflows.featuredProtocol, featuredProtocol as string)
      );
    } else {
      conditions.push(eq(workflows.featured, isFeaturedRequest));
    }

    if (workflowIdFilter) {
      conditions.push(inArray(workflows.id, workflowIdFilter));
    }

    const publicWorkflows = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        description: workflows.description,
        organizationId: workflows.organizationId,
        featured: workflows.featured,
        featuredOrder: workflows.featuredOrder,
        featuredProtocol: workflows.featuredProtocol,
        featuredProtocolOrder: workflows.featuredProtocolOrder,
        projectId: workflows.projectId,
        tagId: workflows.tagId,
        nodes: workflows.nodes,
        edges: workflows.edges,
        visibility: workflows.visibility,
        enabled: workflows.enabled,
        createdAt: workflows.createdAt,
        updatedAt: workflows.updatedAt,
      })
      .from(workflows)
      .where(and(...conditions))
      .orderBy(
        ...(isProtocolFeaturedRequest
          ? [asc(workflows.featuredProtocolOrder), desc(workflows.updatedAt)]
          : isFeaturedRequest
            ? [desc(workflows.featuredOrder), desc(workflows.updatedAt)]
            : [desc(workflows.updatedAt)])
      );

    const workflowIds = publicWorkflows.map((w) => w.id);

    // Fetch tags, ratings, and user's own ratings in parallel
    const session = await auth.api
      .getSession({ headers: request.headers })
      .catch(() => null);
    const userId = session?.user?.id;

    const emptyVotes = {} as Record<string, VoteDirection>;
    const emptySet = new Set<string>();

    const [
      tagsByWorkflow,
      scores,
      userVotes,
      userDuplications,
      duplicateCounts,
    ] = await Promise.all([
      fetchTagsByWorkflow(workflowIds),
      fetchScores(workflowIds),
      userId
        ? fetchUserVotes(userId, workflowIds)
        : Promise.resolve(emptyVotes),
      userId
        ? fetchUserDuplications(userId, workflowIds)
        : Promise.resolve(emptySet),
      fetchDuplicateCounts(workflowIds),
    ]);

    // The serialized feed element. nodes/edges are pinned to the projected
    // types so a future edit that drops the projection (or spreads the full
    // row) fails to compile instead of silently leaking node internals.
    type PublicFeedWorkflow = Omit<
      (typeof publicWorkflows)[number],
      "nodes" | "edges" | "createdAt" | "updatedAt"
    > & {
      nodes: PublicFeedNode[];
      edges: PublicFeedEdge[];
      createdAt: string;
      updatedAt: string;
      publicTags: TagInfo[];
      score: number;
      userVote: VoteDirection | null;
      canVote: boolean;
      duplicateCount: number;
      requiredPlan: PlanName | null;
    };

    const mappedWorkflows = publicWorkflows.map(
      (workflow): PublicFeedWorkflow => ({
        ...workflow,
        // Anonymous feed: expose only the graph shape the marketplace renders
        // (positions + node/action type), never node config or secrets.
        nodes: projectNodesForPublicFeed(workflow.nodes),
        edges: projectEdgesForPublicFeed(workflow.edges),
        publicTags: tagsByWorkflow[workflow.id] ?? [],
        score: scores[workflow.id] ?? 0,
        userVote: userVotes[workflow.id] ?? null,
        canVote: userDuplications.has(workflow.id),
        duplicateCount: duplicateCounts[workflow.id] ?? 0,
        requiredPlan: workflowRequiredPlan(workflow.nodes),
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt.toISOString(),
      })
    );

    return NextResponse.json(mappedWorkflows);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get public workflows",
      error,
      {
        endpoint: "/api/workflows/public",
        operation: "get",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get public workflows",
      },
      { status: 500 }
    );
  }
}
