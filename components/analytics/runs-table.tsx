"use client";

import { useAtom, useAtomValue } from "jotai";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  NormalizedStatus,
  StepLog,
  UnifiedRun,
} from "@/lib/analytics/types";
import {
  analyticsLoadingAtom,
  analyticsRangeAtom,
  analyticsRunsAtom,
  analyticsSearchAtom,
  analyticsSourceFilterAtom,
  analyticsStatusFilterAtom,
} from "@/lib/atoms/analytics";
import { getCustomerRunErrorMessage } from "@/lib/errors/customer-message";
import { cn } from "@/lib/utils";
import { SPONSORSHIP_CHAINS } from "@/lib/web3/sponsorship-chains-meta";
import { ProjectDrawer } from "./project-drawer";

const WHITESPACE_RE = /\s+/;
const LEADING_ZEROS_RE = /^0+(?=\d)/;
const TRAILING_ZEROS_RE = /0+$/;
const NON_DIGIT_RE = /\D/;

const CHAIN_NAME_BY_ID = new Map(
  SPONSORSHIP_CHAINS.map((c) => [String(c.chainId), c.name])
);

function networkName(network: string): string {
  return CHAIN_NAME_BY_ID.get(network) ?? network;
}

function formatNetworks(networks: string[]): string {
  if (networks.length === 0) {
    return "--";
  }
  const names = networks.map(networkName);
  if (names.length <= 2) {
    return names.join(", ");
  }
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

const CHAIN_SYMBOL_BY_ID = new Map(
  SPONSORSHIP_CHAINS.map((c) => [String(c.chainId), c.symbol])
);

function chainSymbol(network: string | null): string {
  if (!network) {
    return "";
  }
  return CHAIN_SYMBOL_BY_ID.get(network) ?? "ETH";
}

// Summary amount for the collapsed run row: up to 6 decimals (trailing zeros
// trimmed). The exact value is shown per step when the row is expanded.
function formatGasNative(wei: string | null, network: string | null): string {
  const value = Number(wei);
  if (!wei || Number.isNaN(value) || value === 0) {
    return "--";
  }
  const amount = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value / 1e18);
  return `${amount} ${chainSymbol(network)}`;
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
  network: string | null
): string {
  if (!wei || wei === "0" || NON_DIGIT_RE.test(wei)) {
    return "--";
  }
  return `${formatWeiToDecimal(wei)} ${chainSymbol(network)}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "--";
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

function formatGasAsEth(weiString: string | null): string {
  if (!weiString) {
    return "--";
  }
  const wei = Number(weiString);
  if (Number.isNaN(wei) || wei === 0) {
    return "0 ETH";
  }
  const eth = wei / 1e18;
  return `${eth.toFixed(4)} ETH`;
}

// Run-level gas: multi-network runs can't sum into one token, so they render
// as "Composed" (per-network amounts live in the expanded steps). A single
// network shows its real sponsored total in that network's token.
function runGasDisplay(run: UnifiedRun): ReactNode {
  if (run.networks.length > 1) {
    return "Composed";
  }
  if (run.gasCostWei) {
    return formatGasNative(run.gasCostWei, run.networks[0] ?? run.network);
  }
  return formatGasAsEth(run.gasUsedWei);
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

const STATUS_STYLES: Record<NormalizedStatus, string> = {
  success:
    "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  error: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  system_error:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  external_error:
    "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
  cancelled:
    "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  running: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  pending: "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20",
} as const;

const STATUS_LABELS: Partial<Record<NormalizedStatus, string>> = {
  system_error: "System Error",
  external_error: "External",
};

function StatusBadge({ status }: { status: NormalizedStatus }): ReactNode {
  return (
    <Badge
      className={cn("capitalize", STATUS_STYLES[status])}
      variant="outline"
    >
      {STATUS_LABELS[status] ?? status}
    </Badge>
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

type StepLogRowProps = {
  step: StepLog;
};

function StepLogRow({ step }: StepLogRowProps): ReactNode {
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
          {step.error ? (
            <span
              className="max-w-[40%] truncate rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] leading-tight text-red-700 dark:text-red-400"
              title={step.error}
            >
              {step.error}
            </span>
          ) : null}
        </div>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
        {formatDuration(step.durationMs)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
        {step.network ? networkName(step.network) : "--"}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {formatGasNativeExact(step.gasCostWei, step.network)}
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
      <td className="py-2 pl-10 text-xs text-muted-foreground" colSpan={8}>
        {errorMessage ?? "No step logs available"}
      </td>
    </tr>
  );
}

type ExpandableRunRowProps = {
  run: UnifiedRun;
};

function ExpandableRunRow({ run }: ExpandableRunRowProps): ReactNode {
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
          title={run.networks.map(networkName).join(", ")}
        >
          {formatNetworks(run.networks)}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground">
          {runGasDisplay(run)}
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
  const statusFilter = useAtomValue(analyticsStatusFilterAtom);
  const sourceFilter = useAtomValue(analyticsSourceFilterAtom);
  const search = useAtomValue(analyticsSearchAtom);
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
        const params = new URLSearchParams({
          range,
          page: String(newPage),
        });
        if (statusFilter) {
          params.set("status", statusFilter);
        }
        if (sourceFilter) {
          params.set("source", sourceFilter);
        }

        const response = await fetch(
          `/api/analytics/runs?${params.toString()}`
        );
        if (response.ok) {
          const data = (await response.json()) as {
            runs: UnifiedRun[];
            nextCursor: string | null;
            total: number;
            page: number;
            pageSize: number;
          };
          setRunsData(data);
        } else {
          toast.error("Failed to load runs");
        }
      } catch {
        toast.error("Failed to load runs");
      } finally {
        setPageLoading(false);
      }
    },
    [range, statusFilter, sourceFilter, setRunsData, router]
  );

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

  const allRuns = runsData?.runs ?? [];

  const runs = useMemo((): UnifiedRun[] => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return allRuns;
    }
    const terms = query.split(WHITESPACE_RE);
    return allRuns.filter((run) => {
      const name = (run.workflowName ?? run.directType ?? "").toLowerCase();
      const network = (run.network ?? "").toLowerCase();
      const status = run.status.toLowerCase();
      const id = run.id.toLowerCase();
      const searchable = `${name} ${network} ${status} ${id}`;
      return terms.every((term) => searchable.includes(term));
    });
  }, [allRuns, search]);

  const isEmpty = runs.length === 0;
  const isReady = !(loading && isEmpty);

  return (
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
  );
}
