import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAnalyticsSummary } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

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
    const projectId = params.get("projectId") ?? undefined;

    const summary = await getAnalyticsSummary(
      authCtx.organizationId,
      range,
      customStart,
      customEnd,
      projectId
    );

    return NextResponse.json(summary);
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch analytics summary");
  }
}
