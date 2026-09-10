import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getTimeSeries } from "@/lib/analytics/queries";
import { parseTimeRange, parseTimeZone } from "@/lib/analytics/time-range";
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
    // Buckets are truncated in the viewer's zone: truncating in the server's
    // put the whole chart a day out for anyone west of UTC.
    const timeZone = parseTimeZone(params.get("tz"));

    const { buckets, intervalMs } = await getTimeSeries(
      authCtx.organizationId,
      range,
      customStart,
      customEnd,
      projectId,
      timeZone
    );

    return NextResponse.json({ buckets, intervalMs });
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch analytics time series");
  }
}
