"use client";

import { Download, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HISTORY_PAGE_SIZE } from "@/lib/notifications/failure-alerts/constants";
import type { HistoryEntry } from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL } from "./api";

const KIND_LABEL: Record<string, string> = {
  alert: "Alert",
  reminder: "Reminder",
  recovery: "Recovered",
  channel_paused: "Channel paused",
  launch_notice: "Notifications on",
};

const STATE_LABEL: Record<string, string> = {
  pending: "Queued",
  sending: "Sending",
  delivered: "Delivered",
  retrying: "Retrying",
  failed: "Failed",
  capped: "Monthly email limit",
  skipped: "Not sent",
};

function stateTone(state: string): string {
  if (state === "delivered") {
    return "text-keeperhub-green-dark";
  }
  if (state === "failed" || state === "capped") {
    return "text-destructive";
  }
  if (state === "retrying" || state === "pending" || state === "sending") {
    return "text-yellow-600 dark:text-yellow-400";
  }
  return "text-muted-foreground";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Every failure notification the organization sent, newest first: alerts,
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
      try {
        const res = await fetch(query(before));
        const body = (await res.json().catch(() => ({}))) as {
          entries?: HistoryEntry[];
        };
        const page = body.entries ?? [];
        setEntries((prev) => (before ? [...prev, ...page] : page));
        setMore(page.length >= HISTORY_PAGE_SIZE);
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
          <SelectTrigger aria-label="Channel" className="h-8 w-36" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
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

      {entries.length === 0 && !loading && (
        <p className="text-muted-foreground text-sm">
          Nothing sent yet. Alerts, reminders, recoveries and backups show up
          here.
        </p>
      )}

      {entries.length > 0 && (
        <ul className="divide-y rounded-md border">
          {entries.map((entry) => (
            <li
              className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-sm"
              key={entry.id}
            >
              <span className="w-28 shrink-0 text-muted-foreground text-xs tabular-nums">
                {formatTime(entry.createdAt)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {KIND_LABEL[entry.kind] ?? entry.kind}
                  </span>
                  {entry.isBackup && <Badge variant="outline">Backup</Badge>}
                  {entry.workflows.map((w) => (
                    <Link
                      className="truncate underline-offset-4 hover:underline"
                      href={`/workflows/${w.id}`}
                      key={w.id}
                    >
                      {w.name}
                    </Link>
                  ))}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                  {entry.channel === "email" ? null : (
                    <IntegrationIcon
                      className="size-3"
                      integration={entry.channel}
                    />
                  )}
                  <span className="truncate">
                    {CHANNEL_LABEL[
                      entry.channel as keyof typeof CHANNEL_LABEL
                    ] ?? entry.channel}{" "}
                    {entry.channel === "discord"
                      ? (entry.connectionName ?? "")
                      : entry.recipient}
                  </span>
                </span>
                {entry.lastError && entry.state !== "delivered" && (
                  <span className="text-muted-foreground text-xs">
                    {entry.lastError}
                  </span>
                )}
              </span>
              <span
                className={cn("shrink-0 text-xs", stateTone(entry.state))}
                title={
                  entry.attempts > 1 ? `${entry.attempts} attempts` : undefined
                }
              >
                {STATE_LABEL[entry.state] ?? entry.state}
                {entry.attempts > 1 ? ` (${entry.attempts} tries)` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {more && last && (
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
