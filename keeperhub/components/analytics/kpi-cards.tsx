"use client";

import { useAtomValue } from "jotai";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  Fuel,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  analyticsLoadingAtom,
  analyticsSummaryAtom,
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

function formatGasAsEth(weiString: string): string {
  const wei = Number(weiString);
  if (Number.isNaN(wei) || wei === 0) {
    return "0 ETH";
  }
  const eth = wei / 1e18;
  return `${eth.toFixed(4)} ETH`;
}

function computeDelta(current: number, previous: number): number | null {
  if (previous === 0) {
    return current > 0 ? 100 : null;
  }
  return ((current - previous) / previous) * 100;
}

type DeltaDisplayProps = {
  delta: number | null;
  invertColor?: boolean;
};

function DeltaDisplay({
  delta,
  invertColor = false,
}: DeltaDisplayProps): ReactNode {
  if (delta === null) {
    return null;
  }

  const isPositive = delta > 0;
  const isNeutral = delta === 0;

  if (isNeutral) {
    return <span className="text-xs text-muted-foreground">0%</span>;
  }

  const isGood = invertColor ? !isPositive : isPositive;
  const Icon = isPositive ? ArrowUp : ArrowDown;

  return (
    <span
      className={cn(
        "flex items-center gap-0.5 text-xs font-medium",
        isGood
          ? "text-green-600 dark:text-green-400"
          : "text-red-600 dark:text-red-400"
      )}
    >
      <Icon className="size-3" />
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
}

function SkeletonCard(): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="size-10 animate-pulse rounded-lg bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

type KpiCardProps = {
  icon: ReactNode;
  label: string;
  value: string;
  delta: number | null;
  invertDeltaColor?: boolean;
  iconClassName?: string;
};

function KpiCard({
  icon,
  label,
  value,
  delta,
  invertDeltaColor = false,
  iconClassName,
}: KpiCardProps): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold tracking-tight">{value}</p>
            <DeltaDisplay delta={delta} invertColor={invertDeltaColor} />
          </div>
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-lg",
              iconClassName ?? "bg-primary/10 text-primary"
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function KpiCards(): ReactNode {
  const summary = useAtomValue(analyticsSummaryAtom);
  const loading = useAtomValue(analyticsLoadingAtom);

  const cards = useMemo(() => {
    if (!summary) {
      return null;
    }

    const prev = summary.previousPeriod;

    const totalRunsDelta = prev
      ? computeDelta(summary.totalRuns, prev.totalRuns)
      : null;

    const currentRate = summary.successRate * 100;
    const prevRate =
      prev && prev.totalRuns > 0
        ? (prev.successCount / prev.totalRuns) * 100
        : 0;
    const successRateDelta = prev ? computeDelta(currentRate, prevRate) : null;

    const durationDelta =
      prev?.avgDurationMs !== null &&
      prev?.avgDurationMs !== undefined &&
      summary.avgDurationMs !== null
        ? computeDelta(summary.avgDurationMs, prev.avgDurationMs)
        : null;

    const gasDelta = prev
      ? computeDelta(Number(summary.totalGasWei), Number(prev.totalGasWei))
      : null;

    return [
      {
        key: "total-runs",
        icon: <Activity className="size-5" />,
        label: "Total Runs",
        value: summary.totalRuns.toLocaleString(),
        delta: totalRunsDelta,
        invertDeltaColor: false,
        iconClassName: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      },
      {
        key: "success-rate",
        icon: <CheckCircle2 className="size-5" />,
        label: "Success Rate",
        value: `${(summary.successRate * 100).toFixed(1)}%`,
        delta: successRateDelta,
        invertDeltaColor: false,
        iconClassName: "bg-green-500/10 text-green-600 dark:text-green-400",
      },
      {
        key: "avg-duration",
        icon: <Clock className="size-5" />,
        label: "Avg Duration",
        value: formatDuration(summary.avgDurationMs),
        delta: durationDelta,
        invertDeltaColor: true,
        iconClassName: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      },
      {
        key: "gas-spent",
        icon: <Fuel className="size-5" />,
        label: "Gas Spent",
        value: formatGasAsEth(summary.totalGasWei),
        delta: gasDelta,
        invertDeltaColor: true,
        iconClassName: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
      },
    ] as const;
  }, [summary]);

  if (loading && !summary) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!cards) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <KpiCard
          delta={card.delta}
          icon={card.icon}
          iconClassName={card.iconClassName}
          invertDeltaColor={card.invertDeltaColor}
          key={card.key}
          label={card.label}
          value={card.value}
        />
      ))}
    </div>
  );
}
