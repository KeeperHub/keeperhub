"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TimeRange } from "@/lib/analytics/types";
import {
  analyticsCustomEndAtom,
  analyticsCustomStartAtom,
  analyticsLastUpdatedAtom,
  analyticsRangeAtom,
} from "@/lib/atoms/analytics";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "./date-range-filter";

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
  const setCustomStart = useSetAtom(analyticsCustomStartAtom);
  const setCustomEnd = useSetAtom(analyticsCustomEndAtom);
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
      // A preset and a hand-picked window are the same setting, so choosing one
      // has to drop the other or the range would keep the stale dates.
      setCustomStart(null);
      setCustomEnd(null);
      setRange(value);
    },
    [setRange, setCustomStart, setCustomEnd]
  );

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
      </div>

      <div className="flex items-center gap-3">
        <nav aria-label="Time range" className="flex items-center gap-1">
          {rangeButtons}
          <DateRangeFilter />
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
