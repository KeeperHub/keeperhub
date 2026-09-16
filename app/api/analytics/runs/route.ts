import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseRunFilters } from "@/lib/analytics/parse-run-filters";
import { getUnifiedRuns } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { MAX_PAGE_SIZE } from "@/lib/pagination";

/**
 * Ceiling for `page`. getUnifiedRuns turns the page into
 * `fetchLimit = (page - 1) * pageLimit + pageLimit + 1`, and that value becomes
 * the SQL LIMIT on both source queries, so an unbounded page removes the
 * limit's effect entirely: `?page=999999999` asks Postgres for 49999999951
 * rows, which is every run in range for the organization. Both sources are
 * then concatenated and sorted in Node before an empty window is sliced out of
 * them - O(all runs) of work to return nothing.
 *
 * Bounding the page at MAX_PAGE_SIZE caps fetchLimit at 20101 rows, and 200
 * pages of up to 100 is past anything the UI pages through.
 */
const MAX_PAGE = MAX_PAGE_SIZE;

/**
 * Parse a bounded positive-integer pagination parameter, falling back to
 * `undefined` so a value this route will not honour behaves exactly as an
 * absent one and getUnifiedRuns applies its own default.
 *
 * `Number.parseInt` with an exact round-trip, matching parseBoundedInt in
 * app/api/workflows/route.ts and parsePageLimit in lib/pagination.ts. `Number`
 * also reads `0x10` as 16, `1e302` as 1e+302 and `" 3 "` as 3, none of which a
 * caller writing a page number meant, and the round-trip is what rejects them
 * rather than silently accepting a value the caller did not type.
 *
 * The original bug was narrower: `Number("abc")` is NaN and NaN survives both
 * `Math.max(1, ...)` and `Math.min(..., 100)`, so it reached the query, the
 * offset became NaN, `slice(NaN, NaN)` returned nothing, and the echoed
 * parameter serialized as `null` - zero runs beside a non-zero total.
 */
function parsePaginationParam(
  raw: string | null,
  max: number
): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  // parseInt("12abc") is 12 and parseInt(" 5") is 5, so the string must
  // round-trip exactly or the value is not the one the caller wrote.
  if (Number.isNaN(value) || String(value) !== raw) {
    return undefined;
  }
  return value >= 1 && value <= max ? value : undefined;
}

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

    const page = parsePaginationParam(params.get("page"), MAX_PAGE);
    // getUnifiedRuns caps the page size at 100 of its own accord; bounding it
    // here too keeps a rejected value from reading as an accepted one.
    const limit = parsePaginationParam(params.get("limit"), MAX_PAGE_SIZE);

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
