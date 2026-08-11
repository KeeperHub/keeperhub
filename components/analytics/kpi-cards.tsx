"use client";

import { useAtomValue } from "jotai";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  Fuel,
  Info,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatGasSplit } from "@/lib/analytics/format-gas";
import type { TimeRange } from "@/lib/analytics/types";
import {
  analyticsLoadingAtom,
  analyticsRangeAtom,
  analyticsSummaryAtom,
} from "@/lib/atoms/analytics";
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

// Wallet-paid and sponsored gas are tracked in separate ledgers, so the headline
// figure is their sum. BigInt keeps the addition exact before the lossy
// Number() conversion that the delta needs.
function addWeiStrings(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
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
  tooltip?: string;
};

function DeltaDisplay({
  delta,
  invertColor = false,
  tooltip,
}: DeltaDisplayProps): ReactNode {
  if (delta === null) {
    return null;
  }

  const isPositive = delta > 0;
  const isNeutral = delta === 0;
  const isGood = invertColor ? !isPositive : isPositive;
  const Icon = isPositive ? ArrowUp : ArrowDown;

  const content = isNeutral ? (
    <span className="text-xs font-medium">0%</span>
  ) : (
    <span
      className={cn(
        "flex items-center gap-0.5 text-xs font-medium",
        isGood
          ? "text-green-600 dark:text-green-400"
          : "text-red-600 dark:text-red-400"
      )}
    >
      <Icon className="size-3" />
      {Math.abs(delta).toFixed(2)}%
    </span>
  );

  if (!tooltip) {
    return content;
  }

  return (
    <span className="flex items-center gap-1">
      {content}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="About this percentage"
            className="inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground"
            type="button"
          >
            <Info className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </span>
  );
}

const COMPARISON_LABELS: Record<TimeRange, string> = {
  "1h": "the previous hour",
  "24h": "the previous 24 hours",
  "7d": "the previous 7 days",
  "30d": "the previous 30 days",
  custom: "the preceding period of equal length",
};

function SkeletonCard(): ReactNode {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex items-start justify-between">
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

type KpiBreakdownLine = {
  key: string;
  text: string;
  highlighted?: boolean;
};

type KpiCardProps = {
  cardKey: string;
  icon: ReactNode;
  label: string;
  value: string;
  delta: number | null;
  deltaTooltip?: string;
  invertDeltaColor?: boolean;
  iconClassName?: string;
  breakdown?: readonly KpiBreakdownLine[];
  tooltip?: string;
};

function KpiCard({
  cardKey,
  icon,
  label,
  value,
  delta,
  deltaTooltip,
  invertDeltaColor = false,
  iconClassName,
  breakdown,
  tooltip,
}: KpiCardProps): ReactNode {
  return (
    <Card data-kpi={cardKey} data-testid="kpi-card">
      <CardContent className="pt-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1">
              <p className="text-sm text-muted-foreground">{label}</p>
              {tooltip ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={`About ${label}`}
                      className="inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground"
                      type="button"
                    >
                      <Info className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {tooltip}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <p
                className="whitespace-nowrap font-bold text-2xl tracking-tight xl:text-xl"
                data-testid="kpi-value"
              >
                {value}
              </p>
              <DeltaDisplay
                delta={delta}
                invertColor={invertDeltaColor}
                tooltip={deltaTooltip}
              />
            </div>
            {breakdown && breakdown.length > 0 ? (
              <div className="space-y-0.5">
                {breakdown.map((line) => (
                  <p
                    className={cn(
                      "text-xs font-medium",
                      line.highlighted
                        ? "text-green-600 dark:text-green-400"
                        : "text-foreground"
                    )}
                    data-kpi-line={line.key}
                    key={line.key}
                  >
                    {line.text}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg",
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
  const range = useAtomValue(analyticsRangeAtom);

  const cards = useMemo(() => {
    if (!summary) {
      return null;
    }

    const versus = COMPARISON_LABELS[range];
    const deltaTooltip = (metric: string): string =>
      `Change in ${metric} compared with ${versus}.`;

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

    const walletGasWei = summary.totalGasWei;
    const sponsoredGasWei = summary.sponsoredGasWei;
    const totalGasWei = addWeiStrings(walletGasWei, sponsoredGasWei);

    const gasDelta = prev
      ? computeDelta(
          Number(totalGasWei),
          Number(addWeiStrings(prev.totalGasWei, prev.sponsoredGasWei))
        )
      : null;

    const hasSponsoredGas = sponsoredGasWei !== "0" && sponsoredGasWei !== "";
    const gas = formatGasSplit(walletGasWei, sponsoredGasWei);

    return [
      {
        key: "total-runs",
        icon: <Activity className="size-5" />,
        label: "Total Runs",
        value: summary.totalRuns.toLocaleString(),
        delta: totalRunsDelta,
        deltaTooltip: deltaTooltip("total runs"),
        invertDeltaColor: false,
        iconClassName: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      },
      {
        key: "success-rate",
        icon: <CheckCircle2 className="size-5" />,
        label: "Success Rate",
        value: `${(summary.successRate * 100).toFixed(2)}%`,
        delta: successRateDelta,
        deltaTooltip: deltaTooltip("success rate"),
        invertDeltaColor: false,
        iconClassName: "bg-green-500/10 text-green-600 dark:text-green-400",
      },
      {
        key: "avg-duration",
        icon: <Clock className="size-5" />,
        label: "Avg Duration",
        value: formatDuration(summary.avgDurationMs),
        delta: durationDelta,
        deltaTooltip: deltaTooltip("average run duration"),
        invertDeltaColor: true,
        iconClassName: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
      },
      {
        key: "gas-spent",
        icon: <Fuel className="size-5" />,
        label: "Gas Spent",
        value: gas.total,
        delta: gasDelta,
        deltaTooltip: deltaTooltip("total gas spent"),
        invertDeltaColor: true,
        iconClassName: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
        breakdown: hasSponsoredGas
          ? ([
              {
                key: "wallet",
                text: `${gas.wallet} from wallet`,
              },
              {
                key: "sponsored",
                text: `${gas.sponsored} sponsored`,
                highlighted: true,
              },
            ] as const)
          : undefined,
        tooltip: hasSponsoredGas
          ? "Total gas your automations spent on-chain this period, split by who paid. 'From wallet' comes out of your wallet balance. 'Sponsored' is covered by KeeperHub on supported networks."
          : "Total gas your automations spent on-chain this period, paid from your wallet balance.",
      },
    ] as const;
  }, [summary, range]);

  const isReady = !(loading && !summary);

  if (loading && !summary) {
    return (
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        data-ready={String(isReady)}
        data-testid="kpi-cards"
      >
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
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      data-ready={String(isReady)}
      data-testid="kpi-cards"
    >
      {cards.map((card) => (
        <KpiCard
          breakdown={"breakdown" in card ? card.breakdown : undefined}
          cardKey={card.key}
          delta={card.delta}
          deltaTooltip={card.deltaTooltip}
          icon={card.icon}
          iconClassName={card.iconClassName}
          invertDeltaColor={card.invertDeltaColor}
          key={card.key}
          label={card.label}
          tooltip={"tooltip" in card ? card.tooltip : undefined}
          value={card.value}
        />
      ))}
    </div>
  );
}
