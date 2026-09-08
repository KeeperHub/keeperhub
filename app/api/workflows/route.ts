import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { MAX_PAGE_SIZE } from "@/lib/pagination";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

/**
 * The largest offset worth forwarding. Past Number.MAX_SAFE_INTEGER a parsed
 * value has already lost precision, and Postgres answers a bigint overflow
 * whose raw driver message would reach the caller through the catch below.
 */
const MAX_OFFSET = Number.MAX_SAFE_INTEGER;

/**
 * A bounded integer, or null when the parameter was absent. Throws otherwise.
 *
 * Out-of-range is rejected rather than clamped, and that is the one place this
 * endpoint departs from lib/pagination.ts:53. Clamping is only honest when the
 * response can name the size it actually used: the shared helper hands back
 * `meta.pageSize`, so a caller can see it was cut. A bare array has no such
 * field, so a silently shortened page is indistinguishable from the end of the
 * list. Rejecting keeps that ambiguity from existing - a caller gets the page
 * it asked for, or a reason it cannot have it.
 *
 * `min` differs per parameter and the difference is load-bearing: a limit of 0
 * requests nothing, but an offset of 0 is the first page of every pager -
 * `for (let p = 0; ; p++) fetch(?offset=${p * 50})` must not 400 on request one.
 *
 * Number.parseInt rather than Number, matching lib/pagination.ts:49 and
 * app/api/earnings/route.ts:24. Number() also accepts `0x1f4` as 500, `1e2` as
 * 100 and " 5" as 5, none of which a caller writing a page number meant.
 */
function parseBoundedInt(
  raw: string | null,
  name: string,
  { min, max }: { min: number; max: number }
): number | null {
  if (raw === null) {
    return null;
  }
  // parseInt("12abc") is 12 and parseInt(" 5") is 5, so the string must round
  // -trip exactly - otherwise `?limit=50%20OR%201=1` reads as a plain 50, and
  // `?limit=%205` as 5. No trim: whitespace in a numeric query parameter is a
  // malformed request, not a formatting preference.
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || String(value) !== raw || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
  if (value > max) {
    throw new RangeError(`${name} must be <= ${max}`);
  }
  return value;
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authContext = await getDualAuthContext(request, { required: false });
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }

    const { organizationId } = authContext;

    // A caller who presented a Bearer credential and got no principal back had
    // it refused. Answering 200 with an empty list tells an MCP client "nothing
    // here" instead of "reauthenticate", so a revoked or rescoped connection
    // goes quiet and never refreshes. Anonymous callers, who send no
    // credential, keep the empty list.
    if (!organizationId && request.headers.get("Authorization")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The org owns every workflow; the list is purely org-scoped.
    if (!organizationId) {
      return NextResponse.json([], { status: 200 });
    }

    const { searchParams } = new URL(request.url);
    const projectIdFilter = searchParams.get("projectId");
    const tagIdFilter = searchParams.get("tagId");

    let limit: number | null;
    let offset: number | null;
    try {
      limit = parseBoundedInt(searchParams.get("limit"), "limit", {
        min: 1,
        max: MAX_PAGE_SIZE,
      });
      offset = parseBoundedInt(searchParams.get("offset"), "offset", {
        min: 0,
        max: MAX_OFFSET,
      });
    } catch (rangeError) {
      return apiError({
        status: 400,
        code: ApiErrorCodes.INVALID_INPUT,
        detail: (rangeError as RangeError).message,
        requestHeaders: request.headers,
      });
    }

    // Offset alone is meaningless: without a limit the response is the whole
    // list either way, so a client paging by offset would re-read page one
    // forever and never learn why.
    if (offset !== null && limit === null) {
      return apiError({
        status: 400,
        code: ApiErrorCodes.INVALID_INPUT,
        detail: "offset requires limit",
        requestHeaders: request.headers,
      });
    }

    // A soft-deleted workflow is gone as far as every listing surface is
    // concerned. Filtering here rather than in the client keeps this route in
    // step with the other reads and covers the non-browser callers (MCP,
    // API keys) that never ran the client-side filter.
    const conditions = [
      eq(workflows.organizationId, organizationId),
      workflowNotDeleted(),
    ];

    if (projectIdFilter) {
      conditions.push(eq(workflows.projectId, projectIdFilter));
    }
    if (tagIdFilter) {
      conditions.push(eq(workflows.tagId, tagIdFilter));
    }

    const where = and(...conditions);

    const baseQuery = db
      .select()
      .from(workflows)
      .where(where)
      // createdAt is not unique - app/api/onboarding/recommendations hoists one
      // `new Date()` above its insert loop, so seeded rows share a timestamp
      // exactly. Without a tiebreak this is not a total order, and a row on a
      // page boundary can appear on both pages while another is skipped.
      .orderBy(asc(workflows.createdAt), asc(workflows.id));

    const map = (rows: Awaited<typeof baseQuery>) =>
      rows.map((workflow) => ({
        ...workflow,
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt.toISOString(),
      }));

    // The response stays a bare array in both cases. docs/api/index.md tells
    // client authors to key their unwrapping on the endpoint, so the shape has
    // to be the same whether or not a page was requested. A caller walks until
    // it receives fewer rows than it asked for; because an over-large limit is
    // a 400 rather than a clamp, a short page always means the end of the list.
    if (limit === null) {
      return NextResponse.json(map(await baseQuery));
    }

    return NextResponse.json(
      map(await baseQuery.limit(limit).offset(offset ?? 0))
    );
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflows", error, {
      endpoint: "/api/workflows",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflows",
      },
      { status: 500 }
    );
  }
}
