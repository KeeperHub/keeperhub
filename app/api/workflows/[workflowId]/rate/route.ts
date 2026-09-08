import { HttpStatus } from "@/lib/http-status";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, workflowRatings, workflows } from "@/lib/db/schema";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { checkVoteRateLimit } from "@/lib/workflow/editor/vote-rate-limit";
import { VOTE_DIRECTIONS, isValidDirection } from "@/lib/workflow/editor/votes";

type RouteParams = { params: Promise<{ workflowId: string }> };

async function getScore(workflowId: string): Promise<number> {
  const [result] = await db
    .select({
      score: sql<string>`COALESCE(SUM(${workflowRatings.rating}), 0)`,
    })
    .from(workflowRatings)
    .where(eq(workflowRatings.workflowId, workflowId));

  return Number(result.score);
}

async function userHasDuplicated(
  userId: string,
  workflowId: string
): Promise<boolean> {
  const duplicated = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.userId, userId),
        eq(workflows.sourceWorkflowId, workflowId)
      )
    )
    .limit(1);

  return duplicated.length > 0;
}

export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: HttpStatus.UNAUTHORIZED });
    }

    const { id: userId } = session.user;

    const [userRecord] = await db
      .select({ isAnonymous: users.isAnonymous })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (userRecord?.isAnonymous) {
      return NextResponse.json(
        { error: "Sign in with a real account to vote on workflows" },
        { status: HttpStatus.FORBIDDEN }
      );
    }

    const rateLimit = checkVoteRateLimit(userId);
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        NextResponse.json(
          { error: "Too many votes, please try again later" },
          { status: HttpStatus.TOO_MANY_REQUESTS }
        ),
        rateLimit
      );
    }

    const { workflowId } = await params;

    const body: { vote?: unknown } = await request.json();
    const { vote } = body;

    if (!isValidDirection(vote)) {
      return NextResponse.json(
        { error: "Vote must be \"upvote\" or \"downvote\"" },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    const hasDuplicated = await userHasDuplicated(userId, workflowId);
    if (!hasDuplicated) {
      return NextResponse.json(
        { error: "You must use this template before voting" },
        { status: HttpStatus.FORBIDDEN }
      );
    }

    const storedValue = VOTE_DIRECTIONS[vote];

    const existing = await db
      .select({ id: workflowRatings.id, rating: workflowRatings.rating })
      .from(workflowRatings)
      .where(
        and(
          eq(workflowRatings.workflowId, workflowId),
          eq(workflowRatings.userId, userId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const current = existing[0];
      if (current.rating === storedValue) {
        // Same direction: toggle off (remove vote)
        await db
          .delete(workflowRatings)
          .where(eq(workflowRatings.id, current.id));

        const score = await getScore(workflowId);
        return applyRateLimitHeaders(
          NextResponse.json({ userVote: null, score }),
          rateLimit
        );
      }

      // Opposite direction: switch vote
      await db
        .update(workflowRatings)
        .set({ rating: storedValue, updatedAt: new Date() })
        .where(eq(workflowRatings.id, current.id));
    } else {
      // No existing vote: upsert to handle concurrent requests against unique constraint
      await db
        .insert(workflowRatings)
        .values({ workflowId, userId, rating: storedValue })
        .onConflictDoUpdate({
          target: [workflowRatings.workflowId, workflowRatings.userId],
          set: { rating: storedValue, updatedAt: new Date() },
        });
    }

    const score = await getScore(workflowId);
    return applyRateLimitHeaders(
      NextResponse.json({ userVote: vote, score }),
      rateLimit
    );
  } catch (error) {
    return apiError(error, "Failed to vote on workflow");
  }
}
