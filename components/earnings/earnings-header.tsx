"use client";

import { useAtomValue } from "jotai";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { earningsLastUpdatedAtom } from "@/lib/atoms/earnings";
import { cn } from "@/lib/utils";

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

type EarningsHeaderProps = {
  onRefetch?: () => Promise<void>;
};

export function EarningsHeader({
  onRefetch,
}: EarningsHeaderProps): React.ReactNode {
  const lastUpdated = useAtomValue(earningsLastUpdatedAtom);
  const [timeAgo, setTimeAgo] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

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

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
      </div>

      <div className="flex items-center gap-3">
        {onRefetch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={refreshing}
                onClick={() => {
                  handleRefresh().catch(() => {
                    // errors handled in handleRefresh
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
            <TooltipContent>Refresh earnings data</TooltipContent>
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
