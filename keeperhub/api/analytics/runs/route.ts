import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getUnifiedRuns } from "@/keeperhub/lib/analytics/queries";
import { parseTimeRange } from "@/keeperhub/lib/analytics/time-range";
import type {
  NormalizedStatus,
  RunSource,
} from "@/keeperhub/lib/analytics/types";
import { apiError } from "@/keeperhub/lib/api-error";
import { requireOrganization } from "@/keeperhub/lib/middleware/require-org";

const VALID_STATUSES = new Set<NormalizedStatus>([
  "pending",
  "running",
  "success",
  "error",
]);

const VALID_SOURCES = new Set<RunSource>(["workflow", "direct"]);

export const GET = requireOrganization(
  async (req: NextRequest, context): Promise<Response> => {
    try {
      const organizationId = context.organization?.id;
      if (!organizationId) {
        return NextResponse.json(
          { error: "No active organization" },
          { status: 400 }
        );
      }

      const params = req.nextUrl.searchParams;
      const range = parseTimeRange(params.get("range"));
      const customStart = params.get("customStart") ?? undefined;
      const customEnd = params.get("customEnd") ?? undefined;
      const cursor = params.get("cursor") ?? undefined;

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

      const result = await getUnifiedRuns(organizationId, range, {
        cursor,
        limit,
        status,
        source,
        customStart,
        customEnd,
      });

      return NextResponse.json(result);
    } catch (error: unknown) {
      return apiError(error, "Failed to fetch analytics runs");
    }
  }
);
