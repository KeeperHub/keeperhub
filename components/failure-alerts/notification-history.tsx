"use client";

import { Download, Loader2, Mail, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FailureAlertMessageKind } from "@/lib/db/schema-failure-alerts";
import { HISTORY_PAGE_SIZE } from "@/lib/notifications/failure-alerts/constants";
import {
  CHANNEL_LABEL,
  FAILURE_ALERT_KIND_LABEL,
  type HistoryEntry,
  methodText,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { type DeliveryTone, deliveryStatus, formatWhen } from "./format";

const TONE_CLASS: Record<DeliveryTone, string> = {
  delivered: "text-keeperhub-green-dark",
  failed: "text-destructive",
  waiting: WARNING_TEXT,
  muted: "text-muted-foreground",
};

function channelLine(entry: HistoryEntry): string {
  return entry.channel === "email"
    ? `Email ${entry.recipient}`
    : methodText(entry.channel, entry.recipient, entry.connectionName);
}

/** One delivery; the date sits under the title in a narrow column, in its own column from @xl. */
function HistoryRow({ entry }: { entry: HistoryEntry }): React.ReactElement {
  const paused = entry.kind === "channel_paused";
  let title =
    FAILURE_ALERT_KIND_LABEL[entry.kind as FailureAlertMessageKind] ??
    entry.kind;
  if (paused && entry.note) {
    title = `${title}: ${entry.note}`;
  }
  const status = deliveryStatus(entry);
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2 text-sm @xl/settings:grid-cols-[7rem_minmax(0,1fr)_auto]"
      data-kind={entry.kind}
      data-state={entry.state}
      data-testid="failure-alert-history-row"
    >
      <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 @xl/settings:col-start-2">
        <span className="break-words font-medium">{title}</span>
        {entry.isBackup && <Badge variant="outline">Backup</Badge>}
        {entry.workflows.map((w) => (
          <Link
            className="min-w-0 break-words underline-offset-4 hover:underline"
            href={`/workflows/${w.id}`}
            key={w.id}
          >
            {w.name}
          </Link>
        ))}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-1 text-right text-xs @xl/settings:col-start-3",
          TONE_CLASS[status.tone]
        )}
        title={entry.attempts > 1 ? `${entry.attempts} attempts` : undefined}
      >
        {status.label}
        {entry.attempts > 1 ? ` (${entry.attempts} tries)` : ""}
      </span>
      <span className="col-start-1 row-start-2 text-muted-foreground text-xs tabular-nums @xl/settings:row-start-1">
        {formatWhen(entry.createdAt)}
      </span>
      <span className="col-span-2 col-start-1 row-start-3 flex min-w-0 flex-col gap-0.5 text-muted-foreground text-xs @xl/settings:col-span-1 @xl/settings:col-start-2 @xl/settings:row-start-2">
        {paused && entry.channel === "email" ? (
          <span className="break-words">Told {entry.recipient} by email</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            {entry.channel === "email" ? (
              <Mail aria-hidden="true" className="size-3 shrink-0" />
            ) : (
              <IntegrationIcon
                className="size-3 shrink-0"
                integration={entry.channel}
              />
            )}
            <span className="min-w-0 break-words">{channelLine(entry)}</span>
          </span>
        )}
        {entry.note && !paused && <span>{entry.note}</span>}
        {entry.lastError && entry.state !== "delivered" && (
          <span className="break-words">{entry.lastError}</span>
        )}
      </span>
    </li>
  );
}

/** Everything the org sent, newest first, where it went and what happened; or one workflow's. */
export function NotificationHistory({
  organizationId,
  workflowId,
  compact = false,
}: {
  organizationId: string;
  workflowId?: string;
  compact?: boolean;
}): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // The page that failed to load, so Try again asks for the same one again.
  const [failed, setFailed] = useState<{ cursor?: string } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [channel, setChannel] = useState("all");
  // The request in flight; a newer one aborts it so its page is never shown.
  const inFlight = useRef<AbortController | null>(null);
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts/history`;

  const query = useCallback(
    (cursor?: string, format?: "csv"): string => {
      const params = new URLSearchParams();
      if (channel !== "all") {
        params.set("channel", channel);
      }
      if (workflowId) {
        params.set("workflowId", workflowId);
      }
      if (cursor) {
        params.set("cursor", cursor);
      }
      if (format) {
        params.set("format", format);
      }
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    },
    [base, channel, workflowId]
  );

  const load = useCallback(
    async (cursor?: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      setFailed(null);
      try {
        const res = await fetch(query(cursor), { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          entries?: HistoryEntry[];
          nextCursor?: string | null;
        };
        if (controller.signal.aborted) {
          return;
        }
        const page = body.entries ?? [];
        setEntries((prev) => (cursor ? [...prev, ...page] : page));
        setNextCursor(body.nextCursor ?? null);
      } catch {
        if (!controller.signal.aborted) {
          setFailed({ cursor });
        }
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setLoading(false);
        }
      }
    },
    [query]
  );

  useEffect(() => {
    load().catch(() => undefined);
    return () => inFlight.current?.abort();
  }, [load]);

  return (
    <div className="space-y-3" data-testid="failure-alert-history">
      <div className="flex flex-wrap items-center gap-2">
        <Select onValueChange={setChannel} value={channel}>
          <SelectTrigger aria-label="Method" className="h-8 w-36" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All methods</SelectItem>
            {(
              ["email", "slack", "discord", "telegram", "pagerduty"] as const
            ).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {CHANNEL_LABEL[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          aria-label="Refresh"
          disabled={loading}
          onClick={() => load()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
        {!compact && (
          <Button asChild className="ml-auto" size="sm" variant="outline">
            <a download href={query(undefined, "csv")}>
              <Download className="size-3.5" />
              Export CSV
            </a>
          </Button>
        )}
      </div>

      {failed && (
        <Notice role="alert" tone="danger">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Could not load sent alerts.
            <Button
              className="h-auto px-0 text-xs"
              onClick={() => load(failed.cursor)}
              type="button"
              variant="link"
            >
              Try again
            </Button>
          </span>
        </Notice>
      )}

      {entries.length === 0 && !(loading || failed) && (
        <p className="text-muted-foreground text-sm">
          Nothing sent yet. Alerts, tests and method warnings show up here.
        </p>
      )}

      {entries.length > 0 && (
        <ul className="divide-y rounded-md border">
          {entries.map((entry) => (
            <HistoryRow entry={entry} key={entry.id} />
          ))}
        </ul>
      )}

      {nextCursor && !failed && (
        <Button
          disabled={loading}
          onClick={() => load(nextCursor)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Load {HISTORY_PAGE_SIZE} more
        </Button>
      )}
    </div>
  );
}
