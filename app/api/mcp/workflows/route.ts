import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { workflowPayments } from "@/lib/db/schema-payments";
import { HttpStatus } from "@/lib/http-status";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { sanitizeDescription } from "@/lib/sanitize-description";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;

const VALID_SORTS = ["popular", "recent"] as const;
type CatalogSort = (typeof VALID_SORTS)[number] | undefined;

function readSort(value: string | null): CatalogSort {
  if (value === null) {
    return undefined;
  }
  const lower = value.toLowerCase();
  return (VALID_SORTS as readonly string[]).includes(lower)
    ? (lower as CatalogSort)
    : undefined;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

const LISTED_WORKFLOW_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  listedAt: workflows.listedAt,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  organizationId: workflows.organizationId,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
  isListed: workflows.isListed,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
};

const CATALOG_RATE_LIMIT = 60;
const CATALOG_RATE_WINDOW_MS = 60_000;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkIpRateLimit(
      clientIp,
      CATALOG_RATE_LIMIT,
      CATALOG_RATE_WINDOW_MS
    );
    if (!rateCheck.allowed) {
      return applyRateLimitHeaders(
        NextResponse.json(
          { error: "Too many requests" },
          { status: HttpStatus.TOO_MANY_REQUESTS }
        ),
        rateCheck
      );
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") ?? undefined;
    const category = searchParams.get("category") ?? undefined;
    const chain = searchParams.get("chain") ?? undefined;
    const workflowTypeParam = searchParams.get("workflowType");
    if (
      workflowTypeParam !== null &&
      workflowTypeParam !== "read" &&
      workflowTypeParam !== "write"
    ) {
      return NextResponse.json(
        { error: "workflowType must be 'read' or 'write'" },
        { status: HttpStatus.BAD_REQUEST }
      );
    }
    const workflowType = workflowTypeParam ?? undefined;
    const page = Math.max(
      1,
      Number.parseInt(searchParams.get("page") ?? String(DEFAULT_PAGE), 10) ||
        DEFAULT_PAGE
    );
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(
        1,
        Number.parseInt(
          searchParams.get("limit") ?? String(DEFAULT_LIMIT),
          10
        ) || DEFAULT_LIMIT
      )
    );
    const offset = (page - 1) * limit;
    const sort = readSort(searchParams.get("sort"));

    // KEEP-440: soft-deleted workflows must never surface in the public catalog.
    const baseFilter = and(eq(workflows.isListed, true), workflowNotDeleted());
    const textFilter = q
      ? or(
          ilike(workflows.name, `%${escapeLikePattern(q)}%`),
          ilike(workflows.description, `%${escapeLikePattern(q)}%`),
          ilike(workflows.listedSlug, `%${escapeLikePattern(q)}%`)
        )
      : undefined;
    const categoryFilter = category
      ? ilike(workflows.category, `%${escapeLikePattern(category)}%`)
      : undefined;
    const chainFilter = chain
      ? ilike(workflows.chain, `%${escapeLikePattern(chain)}%`)
      : undefined;
    const workflowTypeFilter = workflowType
      ? eq(workflows.workflowType, workflowType)
      : undefined;

    const whereClause = and(
      baseFilter,
      textFilter,
      categoryFilter,
      chainFilter,
      workflowTypeFilter
    );

    const callCountExpr = sql<number>`coalesce(count(${workflowPayments.id})::int, 0)`;
    const rowsQuery =
      sort === "popular"
        ? db
            .select({
              ...LISTED_WORKFLOW_COLUMNS,
              callCount: callCountExpr,
            })
            .from(workflows)
            .leftJoin(
              workflowPayments,
              eq(workflowPayments.workflowId, workflows.id)
            )
            .where(whereClause)
            .groupBy(workflows.id)
            .orderBy(desc(callCountExpr), desc(workflows.id))
            .limit(limit)
            .offset(offset)
        : db
            .select(LISTED_WORKFLOW_COLUMNS)
            .from(workflows)
            .where(whereClause)
            .orderBy(desc(workflows.listedAt))
            .limit(limit)
            .offset(offset);

    const [countResult, rows] = await Promise.all([
      db.select({ count: count() }).from(workflows).where(whereClause),
      rowsQuery,
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    const items = rows.map((row) => ({
      ...row,
      description: row.description
        ? sanitizeDescription(row.description)
        : null,
    }));

    return applyRateLimitHeaders(
      NextResponse.json(
        { items, total, page, limit },
        {
          headers: {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
          },
        }
      ),
      rateCheck
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
