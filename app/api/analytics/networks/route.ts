import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getNetworkBreakdown } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import { apiError } from "@/lib/api-error";
import { requireOrganization } from "@/lib/middleware/require-org";

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
      const projectId = params.get("projectId") ?? undefined;

      const networks = await getNetworkBreakdown(
        organizationId,
        range,
        customStart,
        customEnd,
        projectId
      );

      return NextResponse.json({ networks });
    } catch (error: unknown) {
      return apiError(error, "Failed to fetch network breakdown");
    }
  }
);
