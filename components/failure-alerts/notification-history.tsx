"use client";

import { Download, Loader2, Mail, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
  DELIVERY_STATE_LABEL,
  FAILURE_ALERT_KIND_LABEL,
  type HistoryEntry,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { formatWhen } from "./format";

function stateTone(state: string): string {
  if (state === "delivered") {
    return "text-keeperhub-green-dark";
  }
  if (state === "failed" || state === "capped") {
    return "text-destructive";
  }
  if (state === "retrying" || state === "pending" || state === "sending") {
    return WARNING_TEXT;
  }
  return "text-muted-foreground";
}

function channelLine(entry: HistoryEntry): string {
  const name =
    CHANNEL_LABEL[entry.channel as keyof typeof CHANNEL_LABEL] ?? entry.channel;
  const where =
    entry.channel === "discord"
      ? (entry.connectionName ?? "")
      : entry.recipient;
  return `${name} ${where}`;
}

/**
 * One delivery. In a narrow column (a phone, or the Properties panel) the date
 * sits under the title and the details take the full width; from @xl the date
 * gets a column of its own on the left.
 */
function HistoryRow({ entry }: { entry: HistoryEntry }): React.ReactElement {
  const paused = entry.kind === "channel_paused";
  let title =
    FAILURE_ALERT_KIND_LABEL[entry.kind as FailureAlertMessageKind] ??
    entry.kind;
  if (paused && entry.note) {
    title = `${title}: ${entry.note}`;
  }
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2 text-sm @xl/settings:grid-cols-[7rem_minmax(0,1fr)_auto]">
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
          stateTone(entry.state)
        )}
        title={entry.attempts > 1 ? `${entry.attempts} attempts` : undefined}
      >
        {DELIVERY_STATE_LABEL[entry.state] ?? entry.state}
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

/**
 * Every alert the organization sent, newest first: alerts,
 * reminders, recoveries, backups and notices, with where each went and what
 * happened. Also scoped to one workflow from its Properties panel.
 */
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
  // The page that failed to load, so Retry asks for the same one again.
  const [failed, setFailed] = useState<{ before?: string } | null>(null);
  const [more, setMore] = useState(false);
  const [channel, setChannel] = useState("all");
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts/history`;

  const query = useCallback(
    (before?: string, format?: "csv"): string => {
      const params = new URLSearchParams();
      if (channel !== "all") {
        params.set("channel", channel);
      }
      if (workflowId) {
        params.set("workflowId", workflowId);
      }
      if (before) {
        params.set("before", before);
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
    async (before?: string) => {
      setLoading(true);
      setFailed(null);
      try {
        const res = await fetch(query(before));
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as { entries?: HistoryEntry[] };
        const page = body.entries ?? [];
        setEntries((prev) => (before ? [...prev, ...page] : page));
        setMore(page.length >= HISTORY_PAGE_SIZE);
      } catch {
        setFailed({ before });
      } finally {
        setLoading(false);
      }
    },
    [query]
  );

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const last = entries.at(-1);

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
              onClick={() => load(failed.before)}
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

      {more && last && !failed && (
        <Button
          disabled={loading}
          onClick={() => load(last.createdAt)}
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
