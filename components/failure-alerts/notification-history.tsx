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
import { truncateAddress } from "@/lib/address-utils";
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

/** Columns from 48rem of history width; below, each row stacks with labels. */
const ROW_GRID =
  "@3xl/history:grid @3xl/history:grid-cols-[8rem_minmax(0,1.4fr)_minmax(0,0.9fr)_7rem_minmax(0,1.3fr)_8rem] @3xl/history:gap-x-3";

type Filters = {
  since: string;
  kind: string;
  by: string;
  channel: string;
  to: string;
  result: string;
};
const NO_FILTERS: Filters = {
  since: ANY,
  kind: ANY,
  by: ANY,
  channel: ANY,
  to: "",
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

/** An email as is; a wallet address shortened, with the full one on hover. */
function accountLabel(account: string): string {
  return account.startsWith("0x") && !account.includes("@")
    ? truncateAddress(account)
    : account;
}

/** Between values on a phone's second line; gone in the table. */
const SEP =
  "after:ml-2 after:text-muted-foreground after:content-['·'] @3xl/history:after:content-none";

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
  return (
    <li
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2.5 text-sm",
        ROW_GRID
      )}
      data-kind={entry.kind}
      data-state={entry.state}
      data-testid="failure-alert-history-row"
    >
      <Cell className={SEP} label="When">
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatWhen(entry.createdAt)}
        </span>
      </Cell>
      <Cell
        className="order-first w-full @3xl/history:order-none @3xl/history:w-auto"
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
        {entry.note && !methodPaused && (
          <span className="block text-muted-foreground text-xs">
            {entry.note}
          </span>
        )}
      </Cell>
      <Cell
        className={entry.by === "KeeperHub" ? "hidden @3xl/history:block" : SEP}
        label="By"
      >
        <span
          className={cn(
            "text-xs",
            entry.by === "KeeperHub" && "text-muted-foreground"
          )}
          data-testid="failure-alert-history-by"
        >
          {entry.by}
        </span>
        {entry.byAccount && (
          <span
            className="break-all text-muted-foreground text-xs @3xl/history:block"
            data-testid="failure-alert-history-by-account"
            title={entry.byAccount}
          >
            {accountLabel(entry.byAccount)}
          </span>
        )}
      </Cell>
      <Cell className={SEP} label="Method">
        <span className="inline-flex items-baseline gap-1.5 text-xs">
          {entry.channel === "email" ? (
            <Mail aria-hidden="true" className="size-3 shrink-0 self-center" />
          ) : (
            <IntegrationIcon
              className="size-3 shrink-0 self-center"
              integration={entry.channel}
            />
          )}
          {method}
        </span>
      </Cell>
      <Cell className={SEP} label="Sent to">
        <span className="text-xs" data-testid="failure-alert-history-to">
          {to}
        </span>
      </Cell>
      <Cell label="Result">
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
  // Pause notices and tests are left out until asked for.
  const [allKinds, setAllKinds] = useState(false);
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
      if (workflowId) {
        params.set("workflowId", workflowId);
      }
      if (!allKinds && filters.kind === ANY) {
        params.set("scope", "alerts");
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
    [base, filters, workflowId, allKinds, compact]
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
    JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) || toDraft !== "";
  const activeCount = (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter(
    (key) => filters[key] !== NO_FILTERS[key]
  ).length;
  const isDefaultView = !(filtered || allKinds || workflowId);
  let emptyText = "No alerts sent yet. Pause notices and tests are left out.";
  if (filtered) {
    emptyText = "Nothing matches these filters.";
  } else if (allKinds) {
    emptyText = "Nothing sent yet.";
  }

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
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
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
          {allKinds ? (
            <button
              className="inline-flex h-7 items-center gap-1 rounded-full bg-muted px-3 text-xs"
              data-testid="failure-alert-history-all-kinds"
              onClick={() => setAllKinds(false)}
              type="button"
            >
              Including pause notices and tests
              <X aria-label="Show alerts only" className="size-3" />
            </button>
          ) : (
            <button
              className="inline-flex h-7 items-center rounded-full border border-dashed px-3 text-muted-foreground text-xs hover:text-foreground"
              data-testid="failure-alert-history-all-kinds"
              onClick={() => setAllKinds(true)}
              type="button"
            >
              + Include pause notices and tests
            </button>
          )}
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
        </div>
      )}

      {!compact && filtersOpen && (
        <div
          className="grid grid-cols-2 gap-2 @3xl/history:grid-cols-[8rem_minmax(0,1.4fr)_minmax(0,0.9fr)_7rem_minmax(0,1.3fr)_8rem] @3xl/history:gap-x-3 @3xl/history:px-3"
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
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!compact && (
          <span
            className="text-xs"
            data-testid="failure-alert-history-summary"
            role="status"
          >
            <span className="font-medium">
              {info.total} {allKinds ? "message" : "alert"}
              {info.total === 1 ? "" : "s"}
              {filtered ? " match" : ""}
            </span>
            {info.total > 0 && (
              <span
                className={
                  notDelivered > 0
                    ? "text-destructive"
                    : "text-keeperhub-green-dark"
                }
              >
                {" "}
                · {notDelivered} not delivered
              </span>
            )}
          </span>
        )}
        {filtered && (
          <Button
            className="px-2 text-xs"
            onClick={() => {
              setToDraft("");
              setFilters(NO_FILTERS);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <X className="size-3" />
            Clear filters
          </Button>
        )}
        <Button
          aria-label="Refresh"
          className="ml-auto"
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

      {entries.length === 0 && !(loading || failedPage !== null) && (
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      )}

      {entries.length > 0 && (
        <div className="rounded-md border">
          <div
            aria-hidden="true"
            className={cn(
              "hidden border-b bg-muted/30 px-3 py-2 font-medium text-muted-foreground text-xs",
              ROW_GRID
            )}
          >
            <span>When</span>
            <span>What</span>
            <span>By</span>
            <span>Method</span>
            <span>Sent to</span>
            <span>Result</span>
          </div>
          <ul className="divide-y">
            {entries.map((entry) => (
              <HistoryRow entry={entry} key={entry.id} />
            ))}
          </ul>
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
