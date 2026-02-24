"use client";

import { Fuel } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SpendCapData = {
  dailyCapWei: string | null;
  dailyUsedWei: string;
};

function weiToEth(weiString: string): number {
  const wei = Number(weiString);
  if (Number.isNaN(wei)) {
    return 0;
  }
  return wei / 1e18;
}

function formatEth(eth: number): string {
  return `${eth.toFixed(4)} ETH`;
}

function getGaugeColor(percentage: number): string {
  if (percentage >= 90) {
    return "bg-red-500";
  }
  if (percentage >= 75) {
    return "bg-yellow-500";
  }
  return "bg-green-500";
}

function getGaugeTextColor(percentage: number): string {
  if (percentage >= 90) {
    return "text-red-600 dark:text-red-400";
  }
  if (percentage >= 75) {
    return "text-yellow-600 dark:text-yellow-400";
  }
  return "text-green-600 dark:text-green-400";
}

function getSpendCapMessage(percentage: number): string {
  if (percentage >= 90) {
    return "Approaching daily spend limit";
  }
  if (percentage >= 75) {
    return "Over 75% of daily limit used";
  }
  return "Within normal spending range";
}

function GaugeSkeleton(): ReactNode {
  return (
    <div className="space-y-3">
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
    </div>
  );
}

export function SpendCapGauge(): ReactNode {
  const [data, setData] = useState<SpendCapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSpendCap = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/analytics/spend-cap");
      if (!response.ok) {
        throw new Error(`Failed to fetch spend cap: ${response.status}`);
      }
      const result = (await response.json()) as SpendCapData;
      setData(result);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load spend cap";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSpendCap().catch(() => {
      /* errors handled in fetchSpendCap */
    });
  }, [fetchSpendCap]);

  const renderContent = (): ReactNode => {
    if (loading) {
      return <GaugeSkeleton />;
    }

    if (error) {
      return (
        <p className="text-sm text-muted-foreground">
          Unable to load spend cap data
        </p>
      );
    }

    if (!data?.dailyCapWei) {
      return (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Fuel className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No spend cap configured
          </p>
        </div>
      );
    }

    const usedEth = weiToEth(data.dailyUsedWei);
    const capEth = weiToEth(data.dailyCapWei);
    const percentage = capEth > 0 ? Math.min((usedEth / capEth) * 100, 100) : 0;

    return (
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span
            className={cn("text-2xl font-bold", getGaugeTextColor(percentage))}
          >
            {percentage.toFixed(1)}%
          </span>
          <span className="text-xs text-muted-foreground">
            {formatEth(usedEth)} / {formatEth(capEth)}
          </span>
        </div>

        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              getGaugeColor(percentage)
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          {getSpendCapMessage(percentage)}
        </p>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily Spend Cap</CardTitle>
      </CardHeader>
      <CardContent>{renderContent()}</CardContent>
    </Card>
  );
}
