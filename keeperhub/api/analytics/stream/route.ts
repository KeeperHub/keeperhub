import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getAnalyticsChecksum,
  getAnalyticsSummary,
} from "@/keeperhub/lib/analytics/queries";
import { parseTimeRange } from "@/keeperhub/lib/analytics/time-range";
import type { AnalyticsStreamEvent } from "@/keeperhub/lib/analytics/types";
import { apiError } from "@/keeperhub/lib/api-error";
import { requireOrganization } from "@/keeperhub/lib/middleware/require-org";

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_LIFETIME_MS = 5 * 60 * 1000;
const MIN_EVENT_INTERVAL_MS = 1000;

function formatSSE(event: AnalyticsStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function fetchAndEmit(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  organizationId: string,
  range: ReturnType<typeof parseTimeRange>,
  customStart: string | undefined,
  customEnd: string | undefined
): Promise<void> {
  const summary = await getAnalyticsSummary(
    organizationId,
    range,
    customStart,
    customEnd
  );

  const event: AnalyticsStreamEvent = {
    type: "summary",
    data: summary,
  };

  controller.enqueue(encoder.encode(formatSSE(event)));
}

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

      let lastChecksum = "";
      let lastEventTime = 0;
      let closed = false;

      const stream = new ReadableStream({
        start(controller): void {
          const encoder = new TextEncoder();
          const startTime = Date.now();

          const cleanup = (): void => {
            closed = true;
            clearInterval(pollTimer);
            clearInterval(heartbeatTimer);
          };

          const pollTimer = setInterval(async () => {
            if (closed) {
              return;
            }

            if (Date.now() - startTime > MAX_LIFETIME_MS) {
              cleanup();
              controller.close();
              return;
            }

            try {
              const checksum = await getAnalyticsChecksum(organizationId);

              if (checksum === lastChecksum) {
                return;
              }

              lastChecksum = checksum;

              const now = Date.now();
              if (now - lastEventTime < MIN_EVENT_INTERVAL_MS) {
                return;
              }
              lastEventTime = now;

              await fetchAndEmit(
                controller,
                encoder,
                organizationId,
                range,
                customStart,
                customEnd
              );
            } catch {
              cleanup();
              controller.close();
            }
          }, POLL_INTERVAL_MS);

          const heartbeatTimer = setInterval(() => {
            if (closed) {
              return;
            }

            try {
              const event: AnalyticsStreamEvent = {
                type: "heartbeat",
                data: { timestamp: new Date().toISOString() },
              };
              controller.enqueue(encoder.encode(formatSSE(event)));
            } catch {
              cleanup();
            }
          }, HEARTBEAT_INTERVAL_MS);

          req.signal.addEventListener("abort", () => {
            cleanup();
            controller.close();
          });
        },
      });

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
