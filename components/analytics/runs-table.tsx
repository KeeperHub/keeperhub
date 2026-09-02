"use client";

import { useAtom, useAtomValue } from "jotai";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildRunsQuery } from "@/lib/analytics/runs-query";
import {
  normalizeRunsResponse,
  type WireRunsResponse,
} from "@/lib/analytics/runs-response";
import { STATUS_DISPLAY } from "@/lib/analytics/status-display";
import type {
  NormalizedStatus,
  StepLog,
  UnifiedRun,
} from "@/lib/analytics/types";
import {
  analyticsCustomEndAtom,
  analyticsCustomStartAtom,
  analyticsDurationFilterAtom,
  analyticsGasFiltersAtom,
  analyticsLoadingAtom,
  analyticsNetworkFiltersAtom,
  analyticsProjectIdAtom,
  analyticsRangeAtom,
  analyticsRunsAtom,
  analyticsSearchAtom,
  analyticsSourceFiltersAtom,
  analyticsStatusFiltersAtom,
} from "@/lib/atoms/analytics";
import { getCustomerRunErrorMessage } from "@/lib/errors/customer-message";
import type { ChainDisplay } from "@/lib/hooks/use-chain-display";
import {
  ChainDisplayProvider,
  FALLBACK_CHAIN_DISPLAY,
  useChainDisplay,
} from "@/lib/hooks/use-chain-display";
import { cn } from "@/lib/utils";
import { ProjectDrawer } from "./project-drawer";

const LEADING_ZEROS_RE = /^0+(?=\d)/;
const TRAILING_ZEROS_RE = /0+$/;
const NON_DIGIT_RE = /\D/;

/** Placeholder for a cell whose value does not apply to this row. */
const NO_VALUE = "-";

// The default tooltip surface inverts the page; run details read better on the
// same panel the rest of the table uses. The arrow goes with it.
const TOOLTIP_SURFACE =
  "border bg-popover text-popover-foreground shadow-md [&>span]:hidden";

const CHAIN_LIST = new Intl.ListFormat("en-US", {
  style: "long",
  type: "conjunction",
});

function formatNetworks(networks: string[], chains: ChainDisplay): string {
  if (networks.length === 0) {
    return NO_VALUE;
  }
  const names = networks.map(chains.name);
  if (names.length <= 2) {
    return names.join(", ");
  }
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

// Summary amount for the collapsed run row: up to 6 decimals (trailing zeros
// trimmed). The exact value is shown per step when the row is expanded.
function formatGasNative(
  wei: string | null,
  network: string | null,
  chains: ChainDisplay
): string {
  const value = Number(wei);
  if (!wei || Number.isNaN(value) || value === 0) {
    return NO_VALUE;
  }
  const amount = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value / 1e18);
  return `${amount} ${chains.gasSymbol(network)}`.trimEnd();
}

// Exact native amount from the wei integer string (no float rounding), for the
// expanded per-step rows where we show the complete gas.
function formatWeiToDecimal(wei: string): string {
  const padded = wei.padStart(19, "0");
  const intPart = padded.slice(0, -18).replace(LEADING_ZEROS_RE, "");
  const frac = padded.slice(-18).replace(TRAILING_ZEROS_RE, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

function formatGasNativeExact(
  wei: string | null,
  network: string | null,
  chains: ChainDisplay
): string {
  if (!wei || wei === "0" || NON_DIGIT_RE.test(wei)) {
    return NO_VALUE;
  }
  return `${formatWeiToDecimal(wei)} ${chains.gasSymbol(network)}`.trimEnd();
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return NO_VALUE;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Run-level gas: a run that spent on more than one chain can't sum into one
// token, so it renders as "Composed" (per-network amounts live in the expanded
// steps). A single chain shows its total in that chain's token.
//
// A run that paid nothing renders as no value no matter how many chains it
// touched. "Composed" answers which chains the spend was split across, so a
// read-only run has nothing to compose - `networks` counts every chain the run
// reached, reads included, and reading that count as a spend put the word on
// runs with an empty gas column in every step.
//
// The question is which chains the gas landed on, not which chains the run
// touched - `networks` carries the second and answers the first only for a run
// whose every step spent gas. A workflow that writes on one chain and reads on
// another has one gas chain and two targeted ones, and its total is perfectly
// summable. `gasNetworks` is the set this actually needs.
//
// Ledger-only gas (a sponsored leg with no step rollup) names no chain of its
// own, so it borrows the run's, which is unambiguous only when the run touched
// a single one. Sponsored wei counts as spend here: the org drew on gas credit
// for it, and `gasCostWei` is the ledger total.
export function runGasComposed(run: UnifiedRun): boolean {
  if (!(run.gasUsedWei ?? run.gasCostWei)) {
    return false;
  }
  return (
    run.gasNetworks.length > 1 ||
    (run.gasNetworks.length === 0 && run.networks.length > 1)
  );
}

// The chains a composed run split its gas across. `gasNetworks` names them
// outright; a ledger-only sponsored leg names none of its own, so it falls back
// to every chain the run touched, which is the ambiguity that composed it.
function composedGasNetworks(run: UnifiedRun): string[] {
  return run.gasNetworks.length > 0 ? run.gasNetworks : run.networks;
}

/** "Composed" carries no meaning alone, so the tooltip names the chains. */
function ComposedGasCell({
  chains,
  run,
}: {
  chains: ChainDisplay;
  run: UnifiedRun;
}): ReactNode {
  const names = CHAIN_LIST.format(composedGasNetworks(run).map(chains.name));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-4">
          Composed
        </span>
      </TooltipTrigger>
      <TooltipContent className={cn(TOOLTIP_SURFACE, "max-w-xs text-left")}>
        {`This run spent gas on ${names}. Those networks have different native tokens, so there is no single total to show. Expand the run for the amount on each.`}
      </TooltipContent>
    </Tooltip>
  );
}

// The step rollup wins over the sponsorship ledger because it covers every
// transaction the run made. A run that starts sponsored and falls back to
// direct signing has only its sponsored leg in the ledger, so preferring the
// ledger would drop the rest.
export function runGasDisplay(
  run: UnifiedRun,
  chains: ChainDisplay = FALLBACK_CHAIN_DISPLAY
): ReactNode {
  const wei = run.gasUsedWei ?? run.gasCostWei;
  if (!wei) {
    return NO_VALUE;
  }
  if (runGasComposed(run)) {
    return <ComposedGasCell chains={chains} run={run} />;
  }
  return formatGasNative(
    wei,
    run.gasNetworks[0] ?? run.networks[0] ?? run.network,
    chains
  );
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// The four outcome badges a user cannot tell apart from the label alone. Each
// one answers "whose fault is it and what do I do about it".
const STATUS_TOOLTIPS: Partial<Record<NormalizedStatus, string>> = {
  skipped:
    "The trigger fired but the run was refused before it started. Either the monthly execution limit was reached, or the workflow uses an action your plan does not include, or a pay-as-you-go charge could not be collected. Nothing ran, so a skipped run is not a failure and does not count towards your success rate or your usage.",
  error:
    "The run started and failed on something in the workflow itself: bad input, a missing or invalid credential, or a 4xx from an endpoint you configured. Fix the workflow and run it again.",
  external_error:
    "The run failed on a third party it called, not on the workflow and not on KeeperHub. Typical causes are an API or endpoint that timed out, a webhook host that was down, or a provider that returned a 5xx. Retrying usually works once the provider recovers.",
  system_error:
    "The run failed inside KeeperHub: dispatch, the queue, or a run that was reaped after it timed out. There is nothing to fix in your workflow.",
};

function StatusBadge({ status }: { status: NormalizedStatus }): ReactNode {
  const badge = (
    <Badge
      className={cn("capitalize", STATUS_DISPLAY[status].badge)}
      variant="outline"
    >
      {STATUS_DISPLAY[status].label}
    </Badge>
  );

  const tooltip = STATUS_TOOLTIPS[status];
  if (!tooltip) {
    return badge;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function SourceBadge({ source }: { source: string }): ReactNode {
  return (
    <Badge className="capitalize" variant="secondary">
      {source}
    </Badge>
  );
}

function getStepStatusColor(status: string): string {
  if (status === "completed" || status === "success") {
    return "bg-green-500";
  }
  if (status === "failed" || status === "error") {
    return "bg-red-500";
  }
  if (status === "running") {
    return "bg-blue-500";
  }
  return "bg-gray-400";
}

const COPIED_FOR_MS = 1500;

function CopyErrorButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (event: MouseEvent): void => {
      event.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FOR_MS);
    },
    [text]
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="Copy error message"
          className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-foreground"
          onClick={handleCopy}
          type="button"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent className={TOOLTIP_SURFACE}>
        {copied ? "Copied" : "Copy error"}
      </TooltipContent>
    </Tooltip>
  );
}

/** The clipped one-liner in the row; hovering it reveals the whole message. */
function StepErrorMessage({ message }: { message: string }): ReactNode {
  return (
    <span className="flex min-w-0 shrink items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 max-w-md truncate rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-700 leading-tight dark:text-red-400">
            {message}
          </span>
        </TooltipTrigger>
        <TooltipContent
          className={cn(
            TOOLTIP_SURFACE,
            "max-w-sm text-left font-mono text-[11px] leading-relaxed wrap-anywhere"
          )}
        >
          {message}
        </TooltipContent>
      </Tooltip>
      <CopyErrorButton text={message} />
    </span>
  );
}

type StepLogRowProps = {
  step: StepLog;
};

function StepLogRow({ step }: StepLogRowProps): ReactNode {
  const chains = useChainDisplay();
  return (
    <tr className="border-t border-dashed border-muted">
      <td colSpan={4}>
        <div className="flex items-center gap-3 py-1.5 pl-10 pr-3">
          <span
            className={cn(
              "inline-block size-1.5 shrink-0 rounded-full",
              getStepStatusColor(step.status)
            )}
          />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {step.nodeName}
            <span className="ml-1.5 text-muted-foreground/60">
              ({step.nodeType})
            </span>
          </span>
          {step.error ? <StepErrorMessage message={step.error} /> : null}
        </div>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
        {formatDuration(step.durationMs)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
        {step.network ? chains.name(step.network) : NO_VALUE}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {formatGasNativeExact(step.gasCostWei, step.network, chains)}
          {step.sponsored ? (
            <span className="rounded bg-green-500/10 px-1 py-0.5 text-[10px] text-green-700 dark:text-green-400">
              sponsored
            </span>
          ) : null}
        </span>
      </td>
      <td />
    </tr>
  );
}

function ExpandedStepRows({
  loadingSteps,
  run,
  steps,
}: {
  loadingSteps: boolean;
  run: UnifiedRun;
  steps: StepLog[];
}): ReactNode {
  if (loadingSteps) {
    return (
      <>
        {Array.from({ length: 3 }, (_, i) => `step-skeleton-${i}`).map(
          (key) => (
            <tr className="border-t border-dashed border-muted" key={key}>
              <td colSpan={4}>
                <div className="py-2 pl-10 pr-3">
                  <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                </div>
              </td>
              <td className="py-2 pr-3">
                <div className="h-3 w-12 animate-pulse rounded bg-muted" />
              </td>
              <td className="py-2 pr-3">
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
              </td>
              <td className="py-2 pr-3">
                <div className="h-3 w-14 animate-pulse rounded bg-muted" />
              </td>
              <td />
            </tr>
          )
        )}
      </>
    );
  }

  if (steps.length > 0) {
    return steps.map((step) => <StepLogRow key={step.id} step={step} />);
  }

  const errorMessage = getCustomerRunErrorMessage(run);
  return (
    <tr>
      <td className="py-2 pl-10 pr-3 text-xs text-muted-foreground" colSpan={8}>
        <div className="flex items-start gap-2">
          {errorMessage ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="line-clamp-3 wrap-anywhere">
                  {errorMessage}
                </span>
              </TooltipTrigger>
              <TooltipContent
                className={cn(
                  TOOLTIP_SURFACE,
                  "max-w-sm text-left font-mono text-[11px] leading-relaxed wrap-anywhere"
                )}
              >
                {errorMessage}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span>No step logs available</span>
          )}
          {errorMessage ? <CopyErrorButton text={errorMessage} /> : null}
        </div>
      </td>
    </tr>
  );
}

type ExpandableRunRowProps = {
  run: UnifiedRun;
};

function ExpandableRunRow({ run }: ExpandableRunRowProps): ReactNode {
  const chains = useChainDisplay();
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<StepLog[]>([]);
  const [loadingSteps, setLoadingSteps] = useState(false);

  const handleToggleExpand = useCallback(async (): Promise<void> => {
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);

    if (run.source === "direct" || steps.length > 0) {
      return;
    }

    setLoadingSteps(true);
    try {
      const response = await fetch(`/api/analytics/runs/${run.id}/steps`);
      if (response.ok) {
        const data = (await response.json()) as StepLog[];
        setSteps(data);
      }
    } finally {
      setLoadingSteps(false);
    }
  }, [expanded, steps.length, run.id, run.source]);

  const isDeleted = run.workflowName === "(Deleted)";
  const runName =
    run.source === "workflow"
      ? (run.workflowName ?? "Unnamed Workflow")
      : (run.directType ?? "Direct Execution");

  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <tr
        className={cn(
          "group cursor-pointer transition-colors hover:bg-muted/50",
          expanded && "bg-muted/30"
        )}
        onClick={() => {
          handleToggleExpand().catch(() => {
            /* noop - errors handled with toast in handlePageChange */
          });
        }}
      >
        <td className="w-8 py-3 pl-3">
          <ChevronIcon className="size-4 text-muted-foreground" />
        </td>
        <td className="py-3 pr-3">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-sm font-medium capitalize",
                isDeleted && "italic text-muted-foreground line-through"
              )}
            >
              {runName}
            </span>
            {run.source === "workflow" && run.workflowId && !isDeleted ? (
              <a
                aria-label={`Open ${runName} in a new tab`}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                href={`/workflows/${run.workflowId}`}
                onClick={(e) => e.stopPropagation()}
                rel="noopener"
                target="_blank"
              >
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
            ) : null}
          </div>
        </td>
        <td className="py-3 pr-3">
          <StatusBadge status={run.status} />
        </td>
        <td className="py-3 pr-3">
          <SourceBadge source={run.source} />
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground">
          {formatDuration(run.durationMs)}
        </td>
        <td
          className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground"
          title={run.networks.map(chains.name).join(", ")}
        >
          {formatNetworks(run.networks, chains)}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground">
          {runGasDisplay(run, chains)}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-right text-sm text-muted-foreground">
          {formatTimeAgo(run.startedAt)}
        </td>
      </tr>
      {expanded ? (
        <ExpandedStepRows loadingSteps={loadingSteps} run={run} steps={steps} />
      ) : null}
    </>
  );
}

function TableSkeleton(): ReactNode {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }, (_, i) => `skeleton-row-${i}`).map((key) => (
        <div className="h-12 w-full animate-pulse rounded bg-muted" key={key} />
      ))}
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  loading,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  loading: boolean;
}): ReactNode {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) {
    return null;
  }

  const rangeStart = (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pagination" className="flex items-center gap-2">
      <span className="font-medium text-muted-foreground text-xs tabular-nums">
        {rangeStart.toLocaleString()}&ndash;{rangeEnd.toLocaleString()} of{" "}
        {total.toLocaleString()}
      </span>
      <Button
        className="size-7 p-0"
        disabled={page <= 1 || loading}
        onClick={() => onPageChange(page - 1)}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <Button
        className="size-7 p-0"
        disabled={page >= totalPages || loading}
        onClick={() => onPageChange(page + 1)}
        size="sm"
        variant="ghost"
      >
        <ChevronRight className="size-3.5" />
      </Button>
    </nav>
  );
}

function RunsTableContent({
  loading,
  isEmpty,
  runs,
  pageLoading,
}: {
  loading: boolean;
  isEmpty: boolean;
  runs: UnifiedRun[];
  pageLoading: boolean;
}): ReactNode {
  if (loading && isEmpty) {
    return <TableSkeleton />;
  }

  if (isEmpty) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No runs found for the selected filters
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto", pageLoading && "opacity-50")}>
      <table className="min-w-[700px] w-full text-left">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="w-8 pb-2 pl-3" />
            <th className="pb-2 pr-3 font-medium">Name</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            <th className="pb-2 pr-3 font-medium">Source</th>
            <th className="pb-2 pr-3 font-medium">Duration</th>
            <th className="pb-2 pr-3 font-medium">Network</th>
            <th className="pb-2 pr-3 font-medium">Gas</th>
            <th className="pb-2 pr-3 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <ExpandableRunRow key={run.id} run={run} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunsTable(): ReactNode {
  const [runsData, setRunsData] = useAtom(analyticsRunsAtom);
  const loading = useAtomValue(analyticsLoadingAtom);
  const range = useAtomValue(analyticsRangeAtom);
  const statuses = useAtomValue(analyticsStatusFiltersAtom);
  const sources = useAtomValue(analyticsSourceFiltersAtom);
  const networks = useAtomValue(analyticsNetworkFiltersAtom);
  const gas = useAtomValue(analyticsGasFiltersAtom);
  const duration = useAtomValue(analyticsDurationFilterAtom);
  const search = useAtomValue(analyticsSearchAtom);
  const projectId = useAtomValue(analyticsProjectIdAtom);
  const customStart = useAtomValue(analyticsCustomStartAtom);
  const customEnd = useAtomValue(analyticsCustomEndAtom);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pageLoading, setPageLoading] = useState(false);

  const currentPage = runsData?.page ?? 1;
  const pageSize = runsData?.pageSize ?? 50;

  const handlePageChange = useCallback(
    async (newPage: number): Promise<void> => {
      setPageLoading(true);

      // Update URL without full navigation
      const url = new URL(window.location.href);
      if (newPage > 1) {
        url.searchParams.set("page", String(newPage));
      } else {
        url.searchParams.delete("page");
      }
      router.replace(url.pathname + url.search, { scroll: false });

      try {
        const query = buildRunsQuery({
          range,
          statuses,
          sources,
          networks,
          gas,
          duration,
          search,
          projectId,
          customStart,
          customEnd,
          page: newPage,
        });

        const response = await fetch(`/api/analytics/runs?${query}`);
        if (response.ok) {
          const data = (await response.json()) as WireRunsResponse;
          setRunsData(normalizeRunsResponse(data));
        } else {
          toast.error("Failed to load runs");
        }
      } catch {
        toast.error("Failed to load runs");
      } finally {
        setPageLoading(false);
      }
    },
    [
      range,
      statuses,
      sources,
      networks,
      gas,
      duration,
      search,
      projectId,
      customStart,
      customEnd,
      setRunsData,
      router,
    ]
  );

  // A changed filter set restarts the listing at page 1 - useAnalytics refetches
  // without a page - so a ?page= left in the URL outlives the result it
  // described, and the restore below would replay it against a filter set that
  // never produced it. Dropping it keeps the URL and the rendered page in step.
  const filterKey = JSON.stringify([
    range,
    statuses,
    sources,
    networks,
    gas,
    duration,
    search,
    projectId,
    customStart,
    customEnd,
  ]);
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) {
      return;
    }
    lastFilterKey.current = filterKey;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("page")) {
      return;
    }
    url.searchParams.delete("page");
    router.replace(url.pathname + url.search, { scroll: false });
  }, [filterKey, router]);

  // Restore page from URL ?page= param once after initial data load
  const urlPage = Number(searchParams.get("page")) || 1;
  const hasRestoredPage = useRef(false);
  useEffect(() => {
    if (hasRestoredPage.current || !runsData || urlPage <= 1) {
      return;
    }
    hasRestoredPage.current = true;
    handlePageChange(urlPage).catch(() => {
      /* noop - errors handled with toast in handlePageChange */
    });
  }, [urlPage, runsData, handlePageChange]);

  // Every filter, search included, now narrows the query, so the page the
  // server returned is the page to render. Filtering it again here would make
  // the row count disagree with the pagination total.
  const runs = runsData?.runs ?? [];

  const isEmpty = runs.length === 0;
  const isReady = !(loading && isEmpty);

  return (
    <ChainDisplayProvider>
      <div
        className="flex gap-0 overflow-hidden rounded-xl border"
        data-ready={String(isReady)}
        data-testid="runs-table"
      >
        <ProjectDrawer />
        <Card className="flex-1 rounded-none border-0">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Workflow Runs</span>
              <Pagination
                loading={pageLoading}
                onPageChange={(p) => {
                  handlePageChange(p).catch(() => {
                    /* noop - errors handled with toast in handlePageChange */
                  });
                }}
                page={currentPage}
                pageSize={pageSize}
                total={runsData?.total ?? 0}
              />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RunsTableContent
              isEmpty={isEmpty}
              loading={loading}
              pageLoading={pageLoading}
              runs={runs}
            />
          </CardContent>
        </Card>
      </div>
    </ChainDisplayProvider>
  );
}
