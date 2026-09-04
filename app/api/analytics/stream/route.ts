import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getAnalyticsChecksum,
  getAnalyticsSummary,
} from "@/lib/analytics/queries";
import { createAnalyticsStreamStart } from "@/lib/analytics/stream-start";
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
  if (authCtx.isAnonymous) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
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

    const start = createAnalyticsStreamStart({
      signal: req.signal,
      organizationId: authCtx.organizationId,
      range,
      customStart,
      customEnd,
      projectId,
      deps: {
        getChecksum: getAnalyticsChecksum,
        getSummary: getAnalyticsSummary,
      },
    });

    const stream = new ReadableStream<Uint8Array>({ start });

    return await Promise.resolve(
      new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
    );
  } catch (error: unknown) {
    return apiError(error, "Failed to start analytics stream");
  }
}
