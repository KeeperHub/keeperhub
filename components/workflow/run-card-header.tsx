"use client";

import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  runLineSpoken,
  runLineTitle,
  shortDuration,
  shortTimeAgo,
  stepCountLabel,
} from "@/lib/workflow/run-line";

// A run's status in a word or two, for the status button's name.
const SPOKEN_STATUS: Record<string, string> = {
  success: "succeeded",
  error: "failed",
  system_error: "system error",
  running: "running",
  cancelled: "cancelled",
  skipped: "skipped",
};

export function spokenRunStatus(status: string): string {
  return SPOKEN_STATUS[status] ?? "pending";
}

/** The step count a card shows: an open run's loaded logs can be a poll ahead of the list. */
export function runCardStepCount(
  listedCount: number,
  isExpanded: boolean,
  loadedLogs: readonly { nodeId: string }[]
): number {
  if (!isExpanded) {
    return listedCount;
  }
  return Math.max(listedCount, new Set(loadedLogs.map((log) => log.nodeId)).size);
}

type RunCardHeaderProps = {
  runNumber: number;
  status: string;
  statusTitle: string;
  statusDotClass: string;
  statusIcon: ReactNode;
  isExpanded: boolean;
  startedAt: string | Date;
  durationMs: number | null;
  stepCount: number;
  ranVersion: number | null;
  onToggle: () => void;
  onSelect: () => void;
  onOpenVersion: (version: number) => void;
};

export function RunCardHeader({
  runNumber,
  status,
  statusTitle,
  statusDotClass,
  statusIcon,
  isExpanded,
  startedAt,
  durationMs,
  stepCount,
  ranVersion,
  onToggle,
  onSelect,
  onOpenVersion,
}: RunCardHeaderProps) {
  const runLine = { startedAt, durationMs, stepCount };
  const stepsName = `Steps of run #${runNumber}`;
  return (
    <div className="flex w-full items-center gap-3 p-4">
      {/* Grows to 44px on touch without moving the card's content. */}
      <button
        aria-expanded={isExpanded}
        aria-label={`${stepsName}, ${spokenRunStatus(status)}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-full border-0 transition-colors hover:bg-muted pointer-coarse:-m-2.5 pointer-coarse:size-11"
        onClick={onToggle}
        type="button"
      >
        <div
          className={cn(
            "flex size-5 items-center justify-center rounded-full border-0",
            statusDotClass
          )}
          title={statusTitle}
        >
          {statusIcon}
        </div>
      </button>

      {/* The version pill sits on the title row, so the info line has the full width. */}
      <div className="relative min-w-0 flex-1">
        {/* Selecting a run also opens or closes it. */}
        <button
          aria-expanded={isExpanded}
          className="w-full min-w-0 text-left transition-colors hover:opacity-80"
          onClick={onSelect}
          type="button"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold text-sm">Run #{runNumber}</span>
          </div>
          <div
            className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs tabular-nums"
            data-testid="run-line"
            title={runLineTitle(runLine)}
          >
            <span className="sr-only">{runLineSpoken(runLine)}</span>
            <span aria-hidden="true" className="min-w-0 truncate">
              {shortTimeAgo(startedAt)}
            </span>
            {durationMs !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span aria-hidden="true" className="shrink-0">
                  {shortDuration(durationMs)}
                </span>
              </>
            )}
            {stepCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  aria-hidden="true"
                  className="shrink-0"
                  data-testid="run-step-count"
                >
                  {stepCountLabel(stepCount)}
                </span>
              </>
            )}
          </div>
        </button>

        {ranVersion !== null && (
          <button
            className="absolute top-0 right-0 flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => onOpenVersion(ranVersion)}
            title={`Ran version ${ranVersion} — open in History`}
            type="button"
          >
            <GitBranch className="size-3" />v{ranVersion}
          </button>
        )}
      </div>

      <button
        aria-expanded={isExpanded}
        aria-label={stepsName}
        className="flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-muted pointer-coarse:-m-2.5 pointer-coarse:size-11"
        onClick={onToggle}
        type="button"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}
