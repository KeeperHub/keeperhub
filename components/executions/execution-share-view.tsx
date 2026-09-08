"use client";

import {
  Check,
  Clock,
  ExternalLink,
  Loader2,
  SkipForward,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { joinExplorerUrl } from "@/lib/build-explorer-url";
import type { TransactionHashEntry } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const TERMINAL_STATUSES = new Set([
  "success",
  "error",
  "system_error",
  "skipped",
  "cancelled",
]);

const MAX_POLL_MS = 30 * 60 * 1000;
const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVALS_MS = [2000, 4000, 8000, 16_000, 30_000];

type ChainExplorerRow = {
  chainId: number;
  explorerUrl: string | null;
};

type ExecutionShareViewProps = {
  executionId: string;
  workflowId: string;
  workflowName: string;
  initialStatus: string;
  hasSession: boolean;
};

type StatusResponse = {
  status: string;
  progress?: {
    percentage: number;
    completedSteps: number;
    totalSteps: number;
    currentNodeName: string | null;
  };
  transactionHashes?: TransactionHashEntry[];
};

function getStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Success";
    case "error":
      return "Failed";
    case "system_error":
      return "System error";
    case "running":
      return "Running";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
    default:
      return status;
  }
}

function StatusIcon({ status }: { status: string }): React.ReactElement {
  switch (status) {
    case "success":
      return <Check aria-hidden="true" className="h-4 w-4" />;
    case "error":
    case "system_error":
      return <X aria-hidden="true" className="h-4 w-4" />;
    case "running":
      return <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />;
    // Terminal, so it must not fall through to the pending clock.
    case "skipped":
      return <SkipForward aria-hidden="true" className="h-4 w-4" />;
    default:
      return <Clock aria-hidden="true" className="h-4 w-4" />;
  }
}

function buildTxExplorerUrl(
  entry: TransactionHashEntry,
  explorerByChainId: Map<number, string>
): string | null {
  if (!entry.chainId) {
    return null;
  }
  const base = explorerByChainId.get(entry.chainId);
  if (!base) {
    return null;
  }
  const path = `/tx/${entry.hash}`;
  return joinExplorerUrl(base, path);
}

export function ExecutionShareView({
  executionId,
  workflowId,
  workflowName,
  initialStatus,
  hasSession,
}: ExecutionShareViewProps): React.ReactElement {
  const [statusData, setStatusData] = useState<StatusResponse>({
    status: initialStatus,
  });
  const [loadError, setLoadError] = useState(false);
  const [explorerByChainId, setExplorerByChainId] = useState<
    Map<number, string>
  >(new Map());

  useEffect(() => {
    let cancelled = false;

    fetch("/api/chains")
      .then((response) => response.json())
      .then((chains: ChainExplorerRow[]) => {
        if (cancelled) {
          return;
        }
        const map = new Map<number, string>();
        for (const chain of chains) {
          if (chain.explorerUrl) {
            map.set(chain.chainId, chain.explorerUrl);
          }
        }
        setExplorerByChainId(map);
      })
      .catch(() => {
        // Explorer links are optional; status polling still works.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastStatus = initialStatus;
    const startedAt = Date.now();

    const scheduleNext = (status: string): void => {
      if (TERMINAL_STATUSES.has(status)) {
        return;
      }
      if (Date.now() - startedAt >= MAX_POLL_MS) {
        return;
      }
      if (attempt >= MAX_POLL_ATTEMPTS) {
        return;
      }
      const delay =
        POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)];
      attempt += 1;
      timeoutId = setTimeout(() => {
        poll().catch(() => {
          // poll() already sets loadError on failure
        });
      }, delay);
    };

    const poll = async (): Promise<void> => {
      try {
        const data = await api.workflow.getExecutionStatus(executionId);
        if (cancelled) {
          return;
        }
        lastStatus = data.status;
        setStatusData(data as StatusResponse);
        setLoadError(false);
        scheduleNext(data.status);
      } catch {
        if (cancelled) {
          return;
        }
        setLoadError(true);
        // Keep polling. api-client throws on any non-2xx, so without this a
        // single 429, a 502 during a rolling deploy, or one dropped request
        // on mobile would end polling for good and leave a still-running run
        // frozen behind a stale-view warning with no way back except a full
        // page reload. The attempt/elapsed caps in scheduleNext still bound
        // the retries, and the backoff widens as attempts accumulate.
        scheduleNext(lastStatus);
      }
    };

    poll().catch(() => {
      // poll() already sets loadError on failure
    });

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [executionId, initialStatus]);

  const percentage = statusData.progress?.percentage ?? 0;
  const txHashes = statusData.transactionHashes ?? [];

  return (
    <main className="flex min-h-screen items-start justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6">
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Workflow execution</p>
          <h1 className="font-semibold text-2xl">{workflowName}</h1>
          {hasSession && (
            <Link
              className="text-primary text-sm hover:underline"
              href={`/workflows/${workflowId}`}
            >
              View workflow
            </Link>
          )}
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium text-xs",
                statusData.status === "success" &&
                  "bg-green-600/15 text-green-700 dark:text-green-400",
                (statusData.status === "error" ||
                  statusData.status === "system_error") &&
                  "bg-destructive/15 text-destructive",
                statusData.status === "running" && "bg-primary/15 text-primary",
                statusData.status === "cancelled" &&
                  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
                // Refused before it started: neutral, not a failure colour.
                statusData.status === "skipped" &&
                  "bg-muted text-muted-foreground"
              )}
            >
              <StatusIcon status={statusData.status} />
              {getStatusLabel(statusData.status)}
            </span>
          </div>

          {statusData.progress && statusData.progress.totalSteps > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-muted-foreground text-xs">
                <span>
                  {statusData.progress.completedSteps} /{" "}
                  {statusData.progress.totalSteps} steps
                </span>
                <span>{percentage}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percentage}%` }}
                />
              </div>
              {statusData.progress.currentNodeName && (
                <p className="text-muted-foreground text-xs">
                  Current: {statusData.progress.currentNodeName}
                </p>
              )}
            </div>
          )}

          {loadError && (
            <p className="text-destructive text-sm">
              Could not refresh status. The view may be stale.
            </p>
          )}
        </div>

        {txHashes.length > 0 && (
          <div className="space-y-2">
            <h2 className="font-medium text-sm">Transactions</h2>
            <ul className="space-y-2">
              {txHashes.map((entry) => {
                const explorerUrl = buildTxExplorerUrl(
                  entry,
                  explorerByChainId
                );
                return (
                  <li
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    key={`${entry.nodeId}-${entry.hash}`}
                  >
                    {entry.nodeName ? (
                      <span className="truncate text-muted-foreground">
                        {entry.nodeName}
                      </span>
                    ) : (
                      <span className="truncate font-mono text-muted-foreground text-xs">
                        {entry.hash.slice(0, 10)}...
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 font-mono text-xs">
                      {entry.nodeName ? `${entry.hash.slice(0, 10)}...` : null}
                      {explorerUrl && (
                        <a
                          className="text-primary hover:text-primary/80"
                          href={explorerUrl}
                          rel="noopener"
                          target="_blank"
                          title="View on explorer"
                        >
                          <ExternalLink
                            aria-hidden="true"
                            className="h-3.5 w-3.5"
                          />
                        </a>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {hasSession ? (
          <Button asChild variant="outline">
            <Link href="/hub">Back to Hub</Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/">Sign in to KeeperHub</Link>
          </Button>
        )}
      </div>
    </main>
  );
}
