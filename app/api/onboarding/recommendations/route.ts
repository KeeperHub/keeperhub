import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, workflows } from "@/lib/db/schema";
import { ONBOARDING_WORKFLOW_FIXTURES } from "@/scripts/seed/fixtures/onboarding-workflows";

const CHIP_SLUGS = [
  "aave-health",
  "aave-health-sepolia",
  "aave-health-base-sepolia",
  "whale-withdrawal",
  "governance",
  "sky-staking",
  "steth-wrap",
  "usds-savings",
] as const;

const SLUG_SET = new Set<string>(CHIP_SLUGS);

export async function GET(request: Request): Promise<NextResponse> {
  const rows = await db
    .select({ id: workflows.id, listedSlug: workflows.listedSlug })
    .from(workflows)
    .where(
      and(
        inArray(workflows.listedSlug, [...CHIP_SLUGS]),
        isNull(workflows.deletedAt),
        isNotNull(workflows.listedSlug)
      )
    );

  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.listedSlug) {
      map[row.listedSlug] = row.id;
    }
  }

  const missing = ONBOARDING_WORKFLOW_FIXTURES.filter(
    (f) => SLUG_SET.has(f.listedSlug) && !map[f.listedSlug]
  );

  if (missing.length > 0) {
    try {
      const session = await auth.api
        .getSession({ headers: request.headers })
        .catch(() => null);
      const userId = session?.user?.id;

      if (userId) {
        const memberRow = await db
          .select({ organizationId: member.organizationId })
          .from(member)
          .where(eq(member.userId, userId))
          .limit(1);

        const orgId = memberRow[0]?.organizationId;
        if (orgId) {
          const now = new Date();
          await Promise.allSettled(
            missing.map((fixture) =>
              db
                .insert(workflows)
                .values({
                  id: fixture.id,
                  name: fixture.name,
                  description: fixture.description,
                  userId,
                  organizationId: orgId,
                  nodes: fixture.nodes,
                  edges: fixture.edges,
                  visibility: "public",
                  enabled: true,
                  featured: true,
                  featuredProtocol: fixture.featuredProtocol,
                  listedSlug: fixture.listedSlug,
                  seededAt: now,
                  createdAt: now,
                  updatedAt: now,
                  deletedAt: null,
                })
                .onConflictDoNothing()
            )
          );

          const freshRows = await db
            .select({ id: workflows.id, listedSlug: workflows.listedSlug })
            .from(workflows)
            .where(
              and(
                inArray(workflows.listedSlug, [...CHIP_SLUGS]),
                isNull(workflows.deletedAt),
                isNotNull(workflows.listedSlug)
              )
            );

          for (const row of freshRows) {
            if (row.listedSlug) {
              map[row.listedSlug] = row.id;
            }
          }
        }
      }
    } catch {
      // best-effort; fall through and return whatever is in map
    }
  }

  return NextResponse.json(map, {
    headers: {
      "Cache-Control": "private, max-age=60, stale-while-revalidate=30",
    },
  });
}
