import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseRunFilters } from "@/lib/analytics/parse-run-filters";
import { getUnifiedRuns } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

/**
 * Parse a positive-integer pagination parameter, falling back to `undefined`
 * so a malformed value behaves exactly as an absent one and getUnifiedRuns
 * applies its own default.
 *
 * The finiteness test is the point. `Number("abc")` is NaN, and NaN survives
 * both `Math.max(1, ...)` and `Math.min(..., 100)`, so an unguarded parse
 * reached the query as NaN: the offset became NaN, `slice(NaN, NaN)` returned
 * nothing, and the echoed parameter serialized as `null`. The response was
 * zero runs beside a non-zero total, which reads as data loss rather than as a
 * rejected parameter.
 *
 * Mirrors parseNonNegativeInt in lib/analytics/parse-run-filters.ts, with a
 * floor of 1 rather than 0: page 0 is not a page, and a limit of 0 is an empty
 * page rather than a default one.
 */
function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
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

    const page = parsePositiveInt(params.get("page"));
    const limit = parsePositiveInt(params.get("limit"));

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
