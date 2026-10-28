import { NextResponse } from "next/server";
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

/**
 * What failure notifications were sent, newest first. Any member may read it.
 * `?format=csv` downloads up to 500 rows.
 */
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
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    const csv = url.searchParams.get("format") === "csv";
    const limit = Number(url.searchParams.get("limit") ?? "") || undefined;

    const entries = await loadHistory(organizationId, {
      channel,
      workflowId,
      before: before && !Number.isNaN(before.getTime()) ? before : undefined,
      limit: csv ? CSV_LIMIT : limit,
    });

    if (csv) {
      return new Response(historyToCsv(entries), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="failure-notifications.csv"',
        },
      });
    }
    return NextResponse.json({ entries });
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
