import { NextResponse } from "next/server";
import { parseRunCursor } from "@/lib/analytics/run-cursor";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrgAccess } from "@/lib/notifications/failure-alerts/route-auth";
import {
  historyToCsv,
  loadHistory,
} from "@/lib/notifications/failure-alerts/settings";

const CHANNELS = new Set([
  "email",
  "slack",
  "discord",
  "telegram",
  "pagerduty",
]);
const CSV_LIMIT = 500;

/** Sent notifications, newest first; any member. `?cursor=` pages; `?format=csv` gives up to 500 rows. */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse | Response> {
  try {
    const { organizationId } = await context.params;
    const access = await resolveOrgAccess(request, organizationId);
    if (access instanceof NextResponse) {
      return access;
    }

    const url = new URL(request.url);
    const channel = url.searchParams.get("channel") ?? undefined;
    if (channel && !CHANNELS.has(channel)) {
      return NextResponse.json(
        { error: "Unknown channel filter." },
        { status: 400 }
      );
    }
    const workflowId = url.searchParams.get("workflowId") ?? undefined;
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = parseRunCursor(cursorRaw);
    if (cursorRaw && !cursor) {
      return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
    }
    const csv = url.searchParams.get("format") === "csv";
    const limit = Number(url.searchParams.get("limit") ?? "") || undefined;

    const { entries, nextCursor } = await loadHistory(organizationId, {
      channel,
      workflowId,
      cursor,
      limit: csv ? CSV_LIMIT : limit,
    });

    if (csv) {
      return new Response(historyToCsv(entries), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="failure-notifications.csv"',
          // The next 500 rows, for callers that page through a full export.
          ...(nextCursor ? { "X-Next-Cursor": nextCursor } : {}),
        },
      });
    }
    return NextResponse.json({ entries, nextCursor });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Failed to load history",
      error,
      { endpoint: "/api/organizations/[organizationId]/failure-alerts/history" }
    );
    return NextResponse.json(
      { error: "Failed to load history" },
      { status: 500 }
    );
  }
}
