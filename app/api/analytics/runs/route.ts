import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseRunFilters } from "@/lib/analytics/parse-run-filters";
import { getUnifiedRuns } from "@/lib/analytics/queries";
import { MAX_PAGE, MAX_RUN_LIMIT } from "@/lib/analytics/runs-query";
import { parseTimeRange } from "@/lib/analytics/time-range";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

/**
 * Ceiling for `limit`, imported from the query layer that applies it so the two
 * cannot drift.
 *
 * Validating against a larger figure accepts a value the query then halves:
 * `?limit=150` was admitted and served 100. Nothing downstream was incoherent
 * - `pageSize` echoes the honoured value - but the worst case is only pinned
 * when the two ceilings agree: with both bound, the largest fetchLimit
 * getUnifiedRuns can be asked for is `199 * 100 + 100 + 1` = 20001 rows.
 */
const MAX_LIMIT = MAX_RUN_LIMIT;

/**
 * Floor for `limit`. Zero is legal and deliberate: with a page size of 0 the
 * query's offset is 0 and its `fetchLimit` is 1, so `?limit=0` reads one row
 * and returns an empty page beside an accurate total - a cheap count, and the
 * behaviour on `staging` today. A floor of 1 would drop it and serve those
 * callers a full 50-row page instead.
 */
const MIN_LIMIT = 0;

/**
 * Parse a bounded integer pagination parameter, falling back to `undefined` so
 * a value this route will not honour behaves exactly as an absent one and
 * getUnifiedRuns applies its own default.
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
  { min, max }: { min: number; max: number }
): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  // parseInt("12abc") is 12 and parseInt(" 5") is 5, so the string must
  // round-trip exactly or the value is not the one the caller wrote.
  if (Number.isNaN(value) || String(value) !== raw || value < min) {
    return undefined;
  }
  // Clamp rather than drop. A dropped value is indistinguishable from an
  // absent one, so getUnifiedRuns would fall back to page 1 and echo it: the
  // caller asks for page 201 and silently receives the first page. Clamping
  // keeps the echoed page and the returned rows describing the same window,
  // and the table caps its pager at MAX_PAGE so it stops where the route does.
  return Math.min(value, max);
}

/**
 * The exact form `Date#toISOString` produces for a four-digit year, which is
 * every cursor this listing mints and the only one it accepts. Year 0000 is
 * excluded: JavaScript has one, Postgres does not.
 */
const MINTED_CURSOR = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A cursor is the ISO `startedAt` of the last row of the previous page, minted
 * by `toISOString()` in lib/analytics/queries.ts and handed back to
 * `new Date(...)` there for the keyset comparison.
 *
 * `Date.parse` admits far more than that, and the extras all end badly.
 * `?cursor=abc` became an Invalid Date, which Postgres rejected and the route
 * surfaced as a 500. `?cursor=-271821-04-20T00:00:00.000Z` parses, but the ISO
 * extended year is outside the range a Postgres timestamp holds and fails the
 * same way. `?cursor=1` parses to 2001-01-01, which the range floor then
 * excludes: zero runs beside the real total, the reading rejected for `page`
 * above. Only the minted shape is forwarded, and it must round-trip exactly.
 *
 * Anything else is treated as absent, so the listing restarts from the newest
 * row and the rows and the total still describe the same window.
 */
function parseCursor(raw: string | null): string | undefined {
  if (raw === null || !MINTED_CURSOR.test(raw)) {
    return undefined;
  }
  const parsed = new Date(raw);
  // "2026-02-31T00:00:00.000Z" has the shape but is not a real instant.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) {
    return undefined;
  }
  return raw;
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
    const cursor = parseCursor(params.get("cursor"));

    const page = parsePaginationParam(params.get("page"), {
      min: 1,
      max: MAX_PAGE,
    });
    const limit = parsePaginationParam(params.get("limit"), {
      min: MIN_LIMIT,
      max: MAX_LIMIT,
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
