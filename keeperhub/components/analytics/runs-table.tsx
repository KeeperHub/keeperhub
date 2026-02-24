"use client";

import { useAtom, useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  NormalizedStatus,
  StepLog,
  UnifiedRun,
} from "@/keeperhub/lib/analytics/types";
import {
  analyticsLoadingAtom,
  analyticsRangeAtom,
  analyticsRunsAtom,
  analyticsSourceFilterAtom,
  analyticsStatusFilterAtom,
} from "@/keeperhub/lib/atoms/analytics";
import { cn } from "@/lib/utils";

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
  running: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  pending: "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20",
} as const;

function StatusBadge({ status }: { status: NormalizedStatus }): ReactNode {
  return (
    <Badge
      className={cn("capitalize", STATUS_STYLES[status])}
      variant="outline"
    >
      {status}
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
      <td colSpan={8}>
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
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatDuration(step.durationMs)}
          </span>
          {step.error ? (
            <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
              {step.error}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ExpandedStepRows({
  loadingSteps,
  steps,
}: {
  loadingSteps: boolean;
  steps: StepLog[];
}): ReactNode {
  if (loadingSteps) {
    return (
      <tr>
        <td className="py-3 text-center" colSpan={8}>
          <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
        </td>
      </tr>
    );
  }

  if (steps.length > 0) {
    return steps.map((step) => <StepLogRow key={step.id} step={step} />);
  }

  return (
    <tr>
      <td className="py-2 pl-10 text-xs text-muted-foreground" colSpan={8}>
        No step logs available
      </td>
    </tr>
  );
}

type ExpandableRunRowProps = {
  run: UnifiedRun;
};

function ExpandableRunRow({ run }: ExpandableRunRowProps): ReactNode {
  const router = useRouter();
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

  const handleNavigate = useCallback((): void => {
    if (run.source === "workflow" && run.workflowId) {
      router.push(`/${run.workflowId}`);
    }
  }, [run.source, run.workflowId, router]);

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
            /* errors handled in handler */
          });
        }}
      >
        <td className="w-8 py-3 pl-3">
          <ChevronIcon className="size-4 text-muted-foreground" />
        </td>
        <td className="py-3 pr-3">
          <StatusBadge status={run.status} />
        </td>
        <td className="py-3 pr-3">
          <SourceBadge source={run.source} />
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
              <button
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  handleNavigate();
                }}
                type="button"
              >
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </button>
            ) : null}
          </div>
          {run.totalSteps !== null ? (
            <span className="text-xs text-muted-foreground">
              {run.completedSteps ?? 0}/{run.totalSteps} steps
            </span>
          ) : null}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground">
          {formatDuration(run.durationMs)}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground">
          {run.network ?? "--"}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-sm text-muted-foreground">
          {formatGasAsEth(run.gasUsedWei)}
        </td>
        <td className="whitespace-nowrap py-3 pr-3 text-right text-sm text-muted-foreground">
          {formatTimeAgo(run.startedAt)}
        </td>
      </tr>
      {expanded ? (
        <ExpandedStepRows loadingSteps={loadingSteps} steps={steps} />
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

function RunsTableContent({
  loading,
  isEmpty,
  runs,
  nextCursor,
  loadingMore,
  handleLoadMore,
}: {
  loading: boolean;
  isEmpty: boolean;
  runs: UnifiedRun[];
  nextCursor: string | null;
  loadingMore: boolean;
  handleLoadMore: () => Promise<void>;
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
    <>
      <div className="overflow-x-auto">
        <table className="min-w-[700px] w-full text-left">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="w-8 pb-2 pl-3" />
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2 pr-3 font-medium">Source</th>
              <th className="pb-2 pr-3 font-medium">Name</th>
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

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button
            disabled={loadingMore}
            onClick={() => {
              handleLoadMore().catch(() => {
                /* errors handled in handler */
              });
            }}
            size="sm"
            variant="outline"
          >
            {loadingMore ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : null}
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function RunsTable(): ReactNode {
  const [runsData, setRunsData] = useAtom(analyticsRunsAtom);
  const loading = useAtomValue(analyticsLoadingAtom);
  const range = useAtomValue(analyticsRangeAtom);
  const statusFilter = useAtomValue(analyticsStatusFilterAtom);
  const sourceFilter = useAtomValue(analyticsSourceFilterAtom);
  const [loadingMore, setLoadingMore] = useState(false);

  const handleLoadMore = useCallback(async (): Promise<void> => {
    if (!runsData?.nextCursor) {
      return;
    }

    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        range,
        cursor: runsData.nextCursor,
      });
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (sourceFilter) {
        params.set("source", sourceFilter);
      }

      const response = await fetch(`/api/analytics/runs?${params.toString()}`);
      if (response.ok) {
        const newData = (await response.json()) as {
          runs: UnifiedRun[];
          nextCursor: string | null;
          total: number;
        };
        setRunsData({
          runs: [...(runsData?.runs ?? []), ...newData.runs],
          nextCursor: newData.nextCursor,
          total: newData.total,
        });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [runsData, range, statusFilter, sourceFilter, setRunsData]);

  const runs = runsData?.runs ?? [];
  const isEmpty = runs.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Runs</span>
          {runsData ? (
            <span className="text-sm font-normal text-muted-foreground">
              {runsData.total.toLocaleString()} total
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <RunsTableContent
          handleLoadMore={handleLoadMore}
          isEmpty={isEmpty}
          loading={loading}
          loadingMore={loadingMore}
          nextCursor={runsData?.nextCursor ?? null}
          runs={runs}
        />
      </CardContent>
    </Card>
  );
}
