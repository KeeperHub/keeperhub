import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  parseNonNegativeInt,
  parseRunFilters,
} from "@/lib/analytics/parse-run-filters";
import { getUnifiedRuns } from "@/lib/analytics/queries";
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
    const cursor = params.get("cursor") ?? undefined;

    // Both are parsed rather than coerced: Number("abc") is NaN, and
    // Math.max(1, NaN) is NaN, which flowed through to
    // offset = (page - 1) * pageLimit and produced an empty page beside a
    // non-zero total -- indistinguishable from data loss. An unreadable
    // value now falls back to the default the query already applies.
    // A blank value is absent rather than zero: Number("") is 0, which would
    // turn `?page=` into a deliberate-looking first page and `?limit=` into
    // a zero-row request.
    const present = (name: string): string | null => {
      const raw = params.get(name);
      return raw !== null && raw.trim() !== "" ? raw : null;
    };

    const parsedPage = parseNonNegativeInt(present("page"));
    const page = parsedPage === undefined ? undefined : Math.max(1, parsedPage);

    const parsedLimit = parseNonNegativeInt(present("limit"));
    const limit =
      parsedLimit === undefined || parsedLimit < 1 ? undefined : parsedLimit;

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
