import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseRunFilters } from "@/lib/analytics/parse-run-filters";
import { getRunFacets } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import type { FacetDimension } from "@/lib/analytics/types";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

/**
 * Run counts per status for the runs filter. Takes the same query string the
 * runs listing takes, so the counts sit under the filters the reader already
 * has applied.
 */
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
    // Explicit, and status-only by default: the dashboard's poll must never
    // pull the step-log counts by accident.
    const valid = new Set<FacetDimension>(["status", "network", "gas"]);
    const dimensions = params
      .getAll("dimension")
      .filter((value): value is FacetDimension =>
        valid.has(value as FacetDimension)
      );
    const facets = await getRunFacets(
      authCtx.organizationId,
      parseTimeRange(params.get("range")),
      {
        customStart: params.get("customStart") ?? undefined,
        customEnd: params.get("customEnd") ?? undefined,
        projectId: params.get("projectId") ?? undefined,
        ...(dimensions.length > 0 ? { dimensions } : {}),
        ...parseRunFilters(params),
      }
    );
    return NextResponse.json(facets);
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch analytics facets");
  }
}
