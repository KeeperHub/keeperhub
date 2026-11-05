import { NextResponse } from "next/server";
import { parseRunCursor } from "@/lib/analytics/run-cursor";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrgAccess } from "@/lib/notifications/failure-alerts/route-auth";
import {
  HISTORY_RESULT_STATES,
  HISTORY_SINCE_MS,
  type HistoryResult,
  type HistorySince,
  historyToCsv,
  loadHistory,
} from "@/lib/notifications/failure-alerts/settings";
import { FAILURE_ALERT_KIND_LABEL } from "@/lib/notifications/failure-alerts/view-types";

const CHANNELS = new Set([
  "email",
  "slack",
  "discord",
  "telegram",
  "pagerduty",
]);
const CSV_LIMIT = 500;

/**
 * Sent notifications, newest first; any member. `?page=` gives a numbered page
 * with totals, `?cursor=` the next one; `?format=csv` up to 500 rows. Filters:
 * channel, kind, result, by, to, since.
 */
const KINDS = new Set(Object.keys(FAILURE_ALERT_KIND_LABEL));
const MAX_TEXT_FILTER = 200;

/** The column filters, each checked against what it may be. */
function parseFilters(params: URLSearchParams):
  | {
      kind?: string;
      result?: HistoryResult;
      by?: string;
      to?: string;
      since?: HistorySince;
    }
  | { error: string } {
  const kind = params.get("kind") || undefined;
  if (kind && !KINDS.has(kind)) {
    return { error: "Unknown type filter." };
  }
  const result = params.get("result") || undefined;
  if (result && !(result in HISTORY_RESULT_STATES)) {
    return { error: "Unknown result filter." };
  }
  const since = params.get("since") || undefined;
  if (since && !(since in HISTORY_SINCE_MS)) {
    return { error: "Unknown time filter." };
  }
  const by = params.get("by")?.trim() || undefined;
  const to = params.get("to")?.trim() || undefined;
  if (
    (by?.length ?? 0) > MAX_TEXT_FILTER ||
    (to?.length ?? 0) > MAX_TEXT_FILTER
  ) {
    return { error: "Filter text is too long." };
  }
  return {
    kind,
    result: result as HistoryResult | undefined,
    by,
    to,
    since: since as HistorySince | undefined,
  };
}

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
    const filters = parseFilters(url.searchParams);
    if ("error" in filters) {
      return NextResponse.json({ error: filters.error }, { status: 400 });
    }
    const pageRaw = url.searchParams.get("page");
    const page = pageRaw === null ? undefined : Number(pageRaw);
    if (page !== undefined && !(Number.isInteger(page) && page >= 1)) {
      return NextResponse.json({ error: "Invalid page." }, { status: 400 });
    }

    const { entries, nextCursor, ...pageInfo } = await loadHistory(
      organizationId,
      {
        channel,
        workflowId,
        cursor,
        // The CSV is the newest 500 that match, whatever page is on screen.
        page: csv ? undefined : page,
        limit: csv ? CSV_LIMIT : limit,
        ...filters,
      }
    );

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
    return NextResponse.json({
      entries,
      nextCursor,
      ...(page === undefined ? {} : pageInfo),
    });
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
