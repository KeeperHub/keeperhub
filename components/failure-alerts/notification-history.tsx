"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Mail,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { EmailText } from "./email-text";
import { type DeliveryTone, deliveryStatus, formatWhen } from "./format";

const TONE_CLASS: Record<DeliveryTone, string> = {
  delivered: "text-keeperhub-green-dark",
  failed: "text-destructive",
  waiting: WARNING_TEXT,
  muted: "text-muted-foreground",
};

const ANY = "all";
const SINCE_OPTIONS = [
  { value: ANY, label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;
const RESULT_OPTIONS = [
  { value: ANY, label: "Any result" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Not delivered" },
  { value: "waiting", label: "Waiting" },
  { value: "withdrawn", label: "Withdrawn" },
] as const;
const CHANNELS = [
  "email",
  "slack",
  "discord",
  "telegram",
  "pagerduty",
] as const;
const TO_DEBOUNCE_MS = 300;

/** When, What, Sent to, Result from 48rem of history width; below, a compact stack. */
const COLUMNS =
  "@3xl/history:grid-cols-[9rem_minmax(0,1.6fr)_minmax(0,1.4fr)_8rem]";
const ROW_GRID = `@3xl/history:grid ${COLUMNS} @3xl/history:gap-x-3`;

/** Which messages the log shows: real alerts, what people did, or everything. */
const SCOPES = [
  { value: "alerts", label: "Alerts only" },
  { value: "people", label: "People's actions" },
  { value: "all", label: "Everything" },
] as const;
type Scope = (typeof SCOPES)[number]["value"];

/** The viewer's time zone abbreviation, e.g. "CET", for the When header. */
function zoneName(): string {
  return (
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

/** "Until 7 Nov, 15:38 CET" in the viewer's time, or "Until it works again (at most 13 Nov)". */
function muteUntilText(until: HistoryEntry["muteUntil"]): string | null {
  if (!until) {
    return null;
  }
  if (until.itWorks) {
    const day = until.at
      ? new Date(until.at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : null;
    return day
      ? `Until it works again (at most ${day})`
      : "Until it works again";
  }
  return until.at ? `Until ${formatWhen(until.at)}` : null;
}

type Filters = {
  since: string;
  kind: string;
  by: string;
  channel: string;
  to: string;
  workflow: string;
  result: string;
};
const NO_FILTERS: Filters = {
  since: ANY,
  kind: ANY,
  by: ANY,
  channel: ANY,
  to: "",
  workflow: "",
  result: ANY,
};

type PageInfo = { page: number; pages: number; total: number };

/** The method's name and where it went, e.g. "Slack" and "#ops". */
function methodAndTarget(entry: HistoryEntry): {
  method: string;
  to: string;
} {
  const method =
    CHANNEL_LABEL[entry.channel as keyof typeof CHANNEL_LABEL] ?? entry.channel;
  if (entry.channel === "email") {
    return { method, to: entry.recipient };
  }
  // A chat row records its kind when it has no destination (Discord).
  const target = methodText(
    entry.channel,
    entry.recipient === entry.channel ? "" : entry.recipient,
    entry.connectionName
  );
  return { method, to: target };
}

/** One value: a table cell from 48rem, an inline item on a phone. */
function Cell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("min-w-0 break-words @3xl/history:block", className)}>
      <span className="sr-only">{label}: </span>
      {children}
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }): React.ReactElement {
  const methodPaused = entry.kind === "channel_paused";
  let what =
    FAILURE_ALERT_KIND_LABEL[entry.kind as FailureAlertMessageKind] ??
    entry.kind;
  if (methodPaused && entry.note) {
    what = `${what}: ${entry.note}`;
  }
  const status = deliveryStatus(entry);
  const { method, to } = methodAndTarget(entry);
  const note = [
    muteUntilText(entry.muteUntil),
    methodPaused ? null : entry.note,
  ]
    .filter(Boolean)
    .join(" · ");
  const person = entry.by === "KeeperHub" ? null : entry.by;
  return (
    <li
      className={cn(
        // Phone: kind and result, then the details, then when and where; table from 48rem.
        "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-sm",
        ROW_GRID
      )}
      data-kind={entry.kind}
      data-state={entry.state}
      data-testid="failure-alert-history-row"
    >
      <Cell
        className="col-start-1 row-start-2 @3xl/history:col-start-1 @3xl/history:row-start-1"
        label="When"
      >
        <span
          className="text-foreground/80 text-xs tabular-nums"
          title={formatWhen(entry.createdAt)}
        >
          {timeAgo(entry.createdAt)}
        </span>
      </Cell>
      <Cell
        className="col-start-1 row-start-1 @3xl/history:col-start-2 @3xl/history:row-start-1"
        label="What"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{what}</span>
          {entry.isBackup && <Badge variant="outline">Backup</Badge>}
          {entry.workflows.map((w) => (
            <Link
              className="min-w-0 break-words text-xs underline underline-offset-4"
              href={`/workflows/${w.id}`}
              key={w.id}
            >
              {w.name}
            </Link>
          ))}
        </span>
        {person && (
          <span
            className="block text-muted-foreground text-xs"
            data-testid="failure-alert-history-by"
          >
            by{" "}
            {entry.byAccount ? (
              <span title={entry.byAccount}>{person}</span>
            ) : (
              person
            )}
          </span>
        )}
        {note && (
          <span
            className="line-clamp-2 block text-muted-foreground text-xs"
            title={note}
          >
            {note}
          </span>
        )}
      </Cell>
      <Cell
        className="col-span-2 col-start-1 row-start-3 @3xl/history:col-span-1 @3xl/history:col-start-3 @3xl/history:row-start-1"
        label="Sent to"
      >
        <span
          className="flex min-w-0 items-baseline gap-1.5 text-xs"
          data-testid="failure-alert-history-to"
        >
          <span
            aria-label={method}
            className="shrink-0 self-center"
            role="img"
            title={method}
          >
            {entry.channel === "email" ? (
              <Mail aria-hidden="true" className="size-3" />
            ) : (
              <IntegrationIcon className="size-3" integration={entry.channel} />
            )}
          </span>
          {entry.channel === "email" ? <EmailText email={to} /> : to}
        </span>
      </Cell>
      <Cell
        className="col-start-2 row-start-1 text-right @3xl/history:col-start-4 @3xl/history:row-start-1 @3xl/history:text-left"
        label="Result"
      >
        <span
          className={cn("text-xs", TONE_CLASS[status.tone])}
          title={entry.attempts > 1 ? `${entry.attempts} attempts` : undefined}
        >
          {status.label}
          {entry.attempts > 1 ? ` (${entry.attempts} tries)` : ""}
        </span>
        {entry.lastError && entry.state !== "delivered" && (
          <span className="block break-words text-muted-foreground text-xs">
            {entry.lastError}
          </span>
        )}
      </Cell>
    </li>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}): React.ReactElement {
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label={label} className="h-8 w-full" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** How many a workflow's panel shows before "View all". */
const COMPACT_LIMIT = 5;

/**
 * Everything the org sent, newest first: real alerts by default, filterable by
 * every column. Compact (a workflow's panel) shows its last few with a link to
 * the full log.
 */
export function NotificationHistory({
  organizationId,
  workflowId,
  compact = false,
  onTotal,
  onClearWorkflow,
}: {
  organizationId: string;
  workflowId?: string;
  compact?: boolean;
  /** The unfiltered alert count, for a tab label. */
  onTotal?: (total: number) => void;
  /** Shown as a removable "One workflow" filter when given with workflowId. */
  onClearWorkflow?: () => void;
}): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // The page that failed to load, so Try again asks for the same one again.
  const [failedPage, setFailedPage] = useState<number | null>(null);
  const [info, setInfo] = useState<PageInfo>({ page: 1, pages: 1, total: 0 });
  const [byOptions, setByOptions] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // The typed address, applied once typing pauses.
  const [toDraft, setToDraft] = useState("");
  // A workflow's name or ID, applied the same way: renames keep old alerts findable by ID.
  const [workflowDraft, setWorkflowDraft] = useState("");
  // Real alerts by default; pause notices and tests are one switch away.
  const [scope, setScope] = useState<Scope>("alerts");
  // Read in the browser: the server's zone is not the viewer's.
  const [zone, setZone] = useState("");
  useEffect(() => setZone(zoneName()), []);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [notDelivered, setNotDelivered] = useState(0);
  // The request in flight; a newer one aborts it so its page is never shown.
  const inFlight = useRef<AbortController | null>(null);
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts/history`;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) =>
        f.to === toDraft.trim() ? f : { ...f, to: toDraft.trim() }
      );
    }, TO_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [toDraft]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) =>
        f.workflow === workflowDraft.trim()
          ? f
          : { ...f, workflow: workflowDraft.trim() }
      );
    }, TO_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [workflowDraft]);

  const query = useCallback(
    (page?: number, format?: "csv"): string => {
      const params = new URLSearchParams();
      for (const key of ["since", "kind", "by", "channel", "result"] as const) {
        if (filters[key] !== ANY) {
          params.set(key, filters[key]);
        }
      }
      if (filters.to) {
        params.set("to", filters.to);
      }
      if (filters.workflow) {
        params.set("workflow", filters.workflow);
      }
      if (workflowId) {
        params.set("workflowId", workflowId);
      }
      if (scope !== "all" && filters.kind === ANY) {
        params.set("scope", scope);
      }
      if (compact) {
        params.set("limit", String(COMPACT_LIMIT));
      }
      if (page) {
        params.set("page", String(page));
      }
      if (format) {
        params.set("format", format);
      }
      return `${base}?${params.toString()}`;
    },
    [base, filters, workflowId, scope, compact]
  );

  const load = useCallback(
    async (page: number) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      setFailedPage(null);
      try {
        const res = await fetch(query(page), { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          entries?: HistoryEntry[];
          page?: number;
          pages?: number;
          total?: number;
          byOptions?: string[];
          notDelivered?: number;
        };
        if (controller.signal.aborted) {
          return;
        }
        setEntries(body.entries ?? []);
        setInfo({
          page: body.page ?? page,
          pages: body.pages ?? 1,
          total: body.total ?? 0,
        });
        setByOptions(body.byOptions ?? []);
        setNotDelivered(body.notDelivered ?? 0);
      } catch {
        if (!controller.signal.aborted) {
          setFailedPage(page);
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

  // A new filter (or a refresh) starts again from the newest page.
  useEffect(() => {
    load(1).catch(() => undefined);
    return () => inFlight.current?.abort();
  }, [load]);

  const goTo = (page: number): void => {
    load(Math.min(Math.max(page, 1), info.pages)).catch(() => undefined);
  };
  const set = (key: keyof Filters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const filtered =
    JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) ||
    toDraft !== "" ||
    workflowDraft !== "";
  const activeCount = (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter(
    (key) => filters[key] !== NO_FILTERS[key]
  ).length;
  const isDefaultView = !(filtered || scope !== "alerts" || workflowId);
  let emptyText = "No alerts sent yet.";
  if (filtered) {
    emptyText = "No messages match these filters.";
  } else if (scope === "people") {
    emptyText = "Nobody has muted, paused or tested anything yet.";
  } else if (scope === "all") {
    emptyText = "Nothing sent yet.";
  }
  const clearFilters = (): void => {
    setToDraft("");
    setWorkflowDraft("");
    setFilters(NO_FILTERS);
  };
  const onlyFailed = filters.result === "failed";

  // The tab label counts alerts in the default view.
  useEffect(() => {
    if (isDefaultView && !loading && failedPage === null) {
      onTotal?.(info.total);
    }
  }, [isDefaultView, loading, failedPage, info.total, onTotal]);
  const first = (info.page - 1) * HISTORY_PAGE_SIZE + 1;
  const last = first + entries.length - 1;

  return (
    <div
      className="@container/history space-y-3"
      data-testid="failure-alert-history"
    >
      <div className="flex flex-wrap items-center gap-2">
        {!compact && (
          <>
            <Button
              aria-expanded={filtersOpen}
              data-testid="failure-alert-history-filters-toggle"
              onClick={() => setFiltersOpen((open) => !open)}
              size="sm"
              type="button"
              variant="outline"
            >
              <SlidersHorizontal className="size-3.5" />
              Filters{activeCount > 0 ? ` (${activeCount})` : ""}
            </Button>
            <fieldset
              aria-label="Show"
              className="inline-flex rounded-md border p-0.5"
              data-testid="failure-alert-history-scope"
            >
              {SCOPES.map((option) => (
                <button
                  aria-pressed={scope === option.value}
                  className={cn(
                    "h-7 rounded px-2.5 text-xs",
                    scope === option.value
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  data-testid={`failure-alert-history-scope-${option.value}`}
                  key={option.value}
                  onClick={() => setScope(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
            {workflowId && onClearWorkflow && (
              <button
                className="inline-flex h-7 items-center gap-1 rounded-full bg-muted px-3 text-xs"
                data-testid="failure-alert-history-workflow-chip"
                onClick={onClearWorkflow}
                type="button"
              >
                One workflow
                <X aria-label="Show every workflow" className="size-3" />
              </button>
            )}
            {filtered && (
              <Button
                className="px-2 text-xs"
                onClick={clearFilters}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X className="size-3" />
                Clear filters
              </Button>
            )}
          </>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!compact && (
            <span
              className="text-xs"
              data-testid="failure-alert-history-summary"
              role="status"
            >
              <span className="font-medium">
                {info.total} {scope === "alerts" ? "alert" : "message"}
                {info.total === 1 ? "" : "s"}
                {filtered ? " match" : ""}
              </span>
              {info.total > 0 && notDelivered === 0 && !onlyFailed && (
                <span className="text-muted-foreground"> · All delivered</span>
              )}
            </span>
          )}
          {!compact && (notDelivered > 0 || onlyFailed) && (
            <Button
              aria-pressed={onlyFailed}
              className={cn(
                "h-7 px-2 text-destructive text-xs hover:text-destructive",
                onlyFailed && "bg-destructive/10"
              )}
              data-testid="failure-alert-history-not-delivered"
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  result: onlyFailed ? ANY : "failed",
                }))
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              {notDelivered} not delivered
            </Button>
          )}
          <Button
            aria-label="Refresh"
            disabled={loading}
            onClick={() => goTo(info.page)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          {!compact && (
            <Button asChild size="sm" variant="outline">
              <a download href={query(undefined, "csv")}>
                <Download className="size-3.5" />
                Export CSV
              </a>
            </Button>
          )}
        </div>
      </div>

      {!compact && filtersOpen && (
        <div
          className={cn(
            "grid grid-cols-2 gap-2 @3xl/history:gap-x-3 @3xl/history:px-3",
            COLUMNS
          )}
          data-testid="failure-alert-history-filters"
        >
          <FilterSelect
            label="When"
            onChange={set("since")}
            options={SINCE_OPTIONS}
            value={filters.since}
          />
          <FilterSelect
            label="What"
            onChange={set("kind")}
            options={[
              { value: ANY, label: "All types" },
              ...Object.entries(FAILURE_ALERT_KIND_LABEL).map(
                ([value, label]) => ({
                  value,
                  label,
                })
              ),
            ]}
            value={filters.kind}
          />
          <Input
            aria-label="Sent to"
            className="h-8 text-xs"
            maxLength={200}
            onChange={(e) => setToDraft(e.target.value)}
            placeholder="Sent to..."
            value={toDraft}
          />
          <FilterSelect
            label="Result"
            onChange={set("result")}
            options={RESULT_OPTIONS}
            value={filters.result}
          />
          <FilterSelect
            label="By"
            onChange={set("by")}
            options={[
              { value: ANY, label: "Anyone" },
              ...byOptions.map((b) => ({ value: b, label: b })),
            ]}
            value={filters.by}
          />
          <FilterSelect
            label="Method"
            onChange={set("channel")}
            options={[
              { value: ANY, label: "All methods" },
              ...CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] })),
            ]}
            value={filters.channel}
          />
          <Input
            aria-label="Workflow"
            // Two columns of its own, so a long name or ID is never clipped.
            className="col-span-2 h-8 text-xs"
            data-testid="failure-alert-history-workflow-filter"
            maxLength={200}
            onChange={(e) => setWorkflowDraft(e.target.value)}
            placeholder="Workflow name or ID"
            value={workflowDraft}
          />
        </div>
      )}

      {failedPage !== null && (
        <Notice role="alert" tone="danger">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Could not load sent alerts.
            <Button
              className="h-auto px-0 text-xs"
              onClick={() => goTo(failedPage)}
              type="button"
              variant="link"
            >
              Try again
            </Button>
          </span>
        </Notice>
      )}

      {failedPage === null && (entries.length > 0 || !loading) && (
        <div className="rounded-md border">
          <div
            aria-hidden="true"
            className={cn(
              "sticky top-0 z-10 hidden rounded-t-md border-b bg-card px-3 py-2 font-medium text-muted-foreground text-xs",
              ROW_GRID
            )}
          >
            <span>When{zone ? ` (${zone})` : ""}</span>
            <span>What</span>
            <span>Sent to</span>
            <span>Result</span>
          </div>
          {entries.length > 0 ? (
            <ul className="divide-y">
              {entries.map((entry) => (
                <HistoryRow entry={entry} key={entry.id} />
              ))}
            </ul>
          ) : (
            <div
              className="space-y-2 px-3 py-10 text-center text-muted-foreground text-sm"
              data-testid="failure-alert-history-empty"
            >
              <p>{emptyText}</p>
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
                {filtered && (
                  <Button
                    className="h-auto px-0 text-xs"
                    onClick={clearFilters}
                    type="button"
                    variant="link"
                  >
                    Clear filters
                  </Button>
                )}
                {scope === "alerts" && !compact && (
                  <span>
                    Pause notices and tests are hidden.{" "}
                    <Button
                      className="h-auto px-0 text-xs"
                      data-testid="failure-alert-history-show-everything"
                      onClick={() => setScope("all")}
                      type="button"
                      variant="link"
                    >
                      Show everything
                    </Button>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {compact && (
        <Link
          className="inline-flex min-h-11 items-center text-xs underline underline-offset-4 sm:min-h-0"
          data-testid="failure-alert-history-view-all"
          href={`/settings/${encodeURIComponent(organizationId)}/alerts?${new URLSearchParams(
            { tab: "sent", ...(workflowId ? { workflow: workflowId } : {}) }
          ).toString()}`}
        >
          View all in Sent alerts
        </Link>
      )}

      {!compact && info.pages > 1 && (
        <nav
          aria-label="Sent alerts pages"
          className="flex flex-wrap items-center justify-between gap-2"
          data-testid="failure-alert-history-pager"
        >
          <div className="flex items-center gap-1">
            <Button
              aria-label="First page"
              disabled={loading || info.page === 1}
              onClick={() => goTo(1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              aria-label="Previous page"
              disabled={loading || info.page === 1}
              onClick={() => goTo(info.page - 1)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
          </div>
          <span className="text-muted-foreground text-xs tabular-nums">
            Page {info.page} of {info.pages}
            {entries.length > 0 ? ` · ${first}–${last} of ${info.total}` : ""}
          </span>
          <div className="flex items-center gap-1">
            <Button
              aria-label="Next page"
              disabled={loading || info.page >= info.pages}
              onClick={() => goTo(info.page + 1)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              aria-label="Last page"
              disabled={loading || info.page >= info.pages}
              onClick={() => goTo(info.pages)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
