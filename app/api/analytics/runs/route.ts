import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getUnifiedRuns } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import type { NormalizedStatus, RunSource } from "@/lib/analytics/types";
import { apiError } from "@/lib/api-error";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

const VALID_STATUSES = new Set<NormalizedStatus>([
  "pending",
  "running",
  "success",
  "error",
  "system_error",
  "external_error",
  "cancelled",
]);

const VALID_SOURCES = new Set<RunSource>(["workflow", "direct"]);

export async function GET(req: NextRequest): Promise<Response> {
  const authCtx = await resolveOrganizationId(req);
  if ("error" in authCtx) {
    return NextResponse.json(
      { error: authCtx.error },
      { status: authCtx.status }
    );
  }
  const scopeError = requireScope(authCtx.scope, SCOPE_MCP_READ);
  if (scopeError) {
    return scopeError;
  }

  try {
    const params = req.nextUrl.searchParams;
    const range = parseTimeRange(params.get("range"));
    const customStart = params.get("customStart") ?? undefined;
    const customEnd = params.get("customEnd") ?? undefined;
    const cursor = params.get("cursor") ?? undefined;

    const pageParam = params.get("page");
    const page = pageParam ? Math.max(1, Number(pageParam)) : undefined;

    const limitParam = params.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;

    const statusParam = params.get("status");
    const status =
      statusParam && VALID_STATUSES.has(statusParam as NormalizedStatus)
        ? (statusParam as NormalizedStatus)
        : undefined;

    const sourceParam = params.get("source");
    const source =
      sourceParam && VALID_SOURCES.has(sourceParam as RunSource)
        ? (sourceParam as RunSource)
        : undefined;

    const projectId = params.get("projectId") ?? undefined;

    const result = await getUnifiedRuns(authCtx.organizationId, range, {
      cursor,
      page,
      limit,
      status,
      source,
      customStart,
      customEnd,
      projectId,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch analytics runs");
  }
}
