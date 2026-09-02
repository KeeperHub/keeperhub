import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseRunFilters } from "@/lib/analytics/parse-run-filters";
import { getStatusFacets } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
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
    const statusCounts = await getStatusFacets(
      authCtx.organizationId,
      parseTimeRange(params.get("range")),
      {
        customStart: params.get("customStart") ?? undefined,
        customEnd: params.get("customEnd") ?? undefined,
        projectId: params.get("projectId") ?? undefined,
        ...parseRunFilters(params),
      }
    );
    return NextResponse.json({ statusCounts });
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch analytics facets");
  }
}
