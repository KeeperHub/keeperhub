import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getAnalyticsChecksum,
  getAnalyticsSummary,
} from "@/lib/analytics/queries";
import { createAnalyticsStreamStart } from "@/lib/analytics/stream-start";
import { getTimeRangeStart, parseTimeRange } from "@/lib/analytics/time-range";
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

      // Resolved once, for the life of the stream. The checksum only has to
      // detect change inside the window this stream is watching, and a fixed
      // bound also stops the window sliding from registering as a change.
      const rangeStart = getTimeRangeStart(range, customStart);

      const start = createAnalyticsStreamStart({
        signal: req.signal,
        organizationId,
        range,
        customStart,
        customEnd,
        projectId,
        deps: {
          getChecksum: (orgId: string) =>
            getAnalyticsChecksum(orgId, rangeStart),
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
);
