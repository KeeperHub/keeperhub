import { type NextRequest, NextResponse } from "next/server";
import { EARNINGS_PAGE_SIZE } from "@/lib/earnings/constants";
import { getEarningsSummary } from "@/lib/earnings/queries";
import { requireOrganization } from "@/lib/middleware/require-org";

const DEFAULT_PAGE = 1;
const MAX_PAGE_SIZE = 50;

/**
 * Parses a positive integer query param, falling back to a default for
 * missing, non-numeric, or out-of-range input. Prevents NaN from reaching
 * drizzle's .offset() / .limit(), which would otherwise produce a
 * confusing Postgres error or silently coerce to 0.
 */
function parseIntParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export const GET = requireOrganization(
  async (req: NextRequest, context): Promise<Response> => {
    const organizationId = context.organization?.id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 403 }
      );
    }

    const url = new URL(req.url);
    const page = parseIntParam(
      url.searchParams.get("page"),
      DEFAULT_PAGE,
      1,
      Number.MAX_SAFE_INTEGER
    );
    const pageSize = parseIntParam(
      url.searchParams.get("pageSize"),
      EARNINGS_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE
    );

    const summary = await getEarningsSummary(organizationId, page, pageSize);

    return NextResponse.json(summary);
  }
);
