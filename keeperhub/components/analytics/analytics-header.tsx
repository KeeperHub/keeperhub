"use client";

import { useAtom, useAtomValue } from "jotai";
import { Radio, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TimeRange } from "@/keeperhub/lib/analytics/types";
import {
  analyticsLastUpdatedAtom,
  analyticsLiveAtom,
  analyticsRangeAtom,
} from "@/keeperhub/lib/atoms/analytics";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

type AnalyticsHeaderProps = {
  onRefetch?: () => Promise<void>;
};

export function AnalyticsHeader({
  onRefetch,
}: AnalyticsHeaderProps): React.ReactNode {
  const [range, setRange] = useAtom(analyticsRangeAtom);
  const [live, setLive] = useAtom(analyticsLiveAtom);
  const lastUpdated = useAtomValue(analyticsLastUpdatedAtom);
  const [timeAgo, setTimeAgo] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

  // Update the "time ago" display every 5 seconds
  useEffect(() => {
    if (!lastUpdated) {
      return;
    }

    setTimeAgo(formatTimeAgo(lastUpdated));

    const interval = setInterval(() => {
      setTimeAgo(formatTimeAgo(lastUpdated));
    }, 5000);

    return (): void => {
      clearInterval(interval);
    };
  }, [lastUpdated]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (!onRefetch) {
      return;
    }
    setRefreshing(true);
    try {
      await onRefetch();
    } finally {
      setRefreshing(false);
    }
  }, [onRefetch]);

  const handleRangeChange = useCallback(
    (value: TimeRange): void => {
      setRange(value);
    },
    [setRange]
  );

  const handleToggleLive = useCallback((): void => {
    setLive((prev) => !prev);
  }, [setLive]);

  const rangeButtons = useMemo(
    () =>
      RANGE_OPTIONS.map((option) => (
        <Button
          key={option.value}
          onClick={() => handleRangeChange(option.value)}
          size="sm"
          variant={range === option.value ? "default" : "outline"}
        >
          {option.label}
        </Button>
      )),
    [range, handleRangeChange]
  );

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                live
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
              )}
              onClick={handleToggleLive}
              type="button"
            >
              <span
                className={cn(
                  "inline-block size-2 rounded-full",
                  live ? "animate-pulse bg-green-500" : "bg-muted-foreground/50"
                )}
              />
              <Radio className="size-3" />
              {live ? "Live" : "Paused"}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {live ? "Receiving live updates" : "Live updates paused"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex items-center gap-3">
        <nav aria-label="Time range" className="flex items-center gap-1">
          {rangeButtons}
        </nav>

        {onRefetch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={refreshing}
                onClick={() => {
                  handleRefresh().catch(() => {
                    /* errors handled in handleRefresh */
                  });
                }}
                size="icon-sm"
                variant="outline"
              >
                <RefreshCw
                  className={cn("size-4", refreshing && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh data</TooltipContent>
          </Tooltip>
        ) : null}

        {lastUpdated ? (
          <span className="text-xs text-muted-foreground">
            Updated {timeAgo}
          </span>
        ) : null}
      </div>
    </header>
  );
}
