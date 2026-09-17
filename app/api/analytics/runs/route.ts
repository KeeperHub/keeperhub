import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  parseBoundedInt,
  parseRunFilters,
} from "@/lib/analytics/parse-run-filters";
import { getUnifiedRuns } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { MAX_PAGE_SIZE } from "@/lib/pagination";

// The highest page this endpoint serves. getUnifiedRuns caps the page size at
// 100, so fetchLimit = (page - 1) * pageSize + pageSize + 1 stays at or below
// 20,001 rows per source here, where an unbounded page reads every run the
// organization holds. 200 pages is 20,000 runs of history at the largest page
// size, past what a numbered pager is used for.
const MAX_RUNS_PAGE = 200;

export async function GET(req: NextRequest): Promise<Response> {
  const authCtx = await resolveOrganizationId(req);
  if ("error" in authCtx) {
    return NextResponse.json(
      { error: authCtx.error },
      { status: authCtx.status }
    );
  }
  const scopeError = requireScope(authCtx.scope, SCOPE_MCP_READ, {
    credentialType: authCtx.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }

  try {
    const params = req.nextUrl.searchParams;
    const range = parseTimeRange(params.get("range"));
    const customStart = params.get("customStart") ?? undefined;
    const customEnd = params.get("customEnd") ?? undefined;
    const cursor = params.get("cursor") ?? undefined;

    // Parsed and bounded rather than coerced, falling back to the query's own
    // defaults (page 1, the default page size) for anything outside the
    // bounds - the convention app/api/earnings/route.ts already follows.
    //
    // The page ceiling is what stops the expensive case. fetchLimit grows
    // linearly with the page, so an unbounded page reads every run the
    // organization holds; at MAX_RUNS_PAGE it stays bounded however large the
    // request.
    //
    // limit keeps 0 legal. ?limit=0 fetches a single row and returns an empty
    // page with an accurate total, which callers use as a cheap count, and
    // dropping it would turn that into a full default-sized page.
    const page = parseBoundedInt(params.get("page"), {
      min: 1,
      max: MAX_RUNS_PAGE,
    });
    const limit = parseBoundedInt(params.get("limit"), {
      min: 0,
      max: MAX_PAGE_SIZE,
    });

    const projectId = params.get("projectId") ?? undefined;

    const result = await getUnifiedRuns(authCtx.organizationId, range, {
      cursor,
      page,
      limit,
      customStart,
      customEnd,
      projectId,
      ...parseRunFilters(params),
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch analytics runs");
  }
}
