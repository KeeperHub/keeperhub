"use client";

import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { STATUS_DISPLAY } from "@/lib/analytics/status-display";
import {
  analyticsLoadingAtom,
  analyticsTimeSeriesAtom,
  analyticsTimeSeriesIntervalAtom,
} from "@/lib/atoms/analytics";

// Colours come from the shared status palette, so a band on this chart is the
// same hue as that status's badge in the table and its swatch in the filter.
const CHART_COLORS = {
  success: STATUS_DISPLAY.success.chartColor,
  error: STATUS_DISPLAY.error.chartColor,
  cancelled: STATUS_DISPLAY.cancelled.chartColor,
  skipped: STATUS_DISPLAY.skipped.chartColor,
  running: STATUS_DISPLAY.running.chartColor,
  pending: STATUS_DISPLAY.pending.chartColor,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Labelled at the granularity the bucket actually covers. Keyed off the range
 * name instead, a two-month custom window printed the same day four times over
 * because its buckets were still an hour wide.
 */
function formatTimestamp(value: string, intervalMs: number): string {
  const date = new Date(value);

  if (intervalMs >= DAY_MS) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  // Buckets this wide only ever cover a window of several days, so the day
  // has to be on the label; an hourly one never does, and the date there is
  // repeated noise.
  if (intervalMs >= 6 * 60 * 60 * 1000) {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
    });
  }

  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTooltipTimestamp(value: string, intervalMs: number): string {
  const date = new Date(value);
  if (intervalMs >= DAY_MS) {
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type TooltipPayloadEntry = {
  name: string;
  value: number;
  color: string;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  intervalMs: number;
};

function ChartTooltip({
  active,
  payload,
  label,
  intervalMs,
}: CustomTooltipProps): ReactNode {
  if (!(active && payload?.length && label)) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">
        {formatTooltipTimestamp(label, intervalMs)}
      </p>
      {payload
        .filter((entry) => entry.value > 0)
        .map((entry) => (
          <div
            className="flex items-center justify-between gap-4 text-sm"
            key={entry.name}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="capitalize">{entry.name}</span>
            </div>
            <span className="font-medium">{entry.value}</span>
          </div>
        ))}
    </div>
  );
}

function ChartSkeleton(): ReactNode {
  return (
    <div className="flex h-[300px] items-center justify-center">
      <div className="h-full w-full animate-pulse rounded bg-muted" />
    </div>
  );
}

function TimeSeriesContent({
  chartData,
  intervalMs,
  loading,
}: {
  chartData: {
    timestamp: string;
    success: number;
    error: number;
    cancelled: number;
    skipped: number;
    pending: number;
    running: number;
  }[];
  intervalMs: number;
  loading: boolean;
}): ReactNode {
  const isEmpty = chartData.length === 0;

  const activeKeys = useMemo(() => {
    const keys = [
      "success",
      "error",
      "cancelled",
      "skipped",
      "running",
      "pending",
    ] as const;
    return keys.filter((key) => chartData.some((d) => d[key] > 0));
  }, [chartData]);

  if (loading && isEmpty) {
    return <ChartSkeleton />;
  }

  if (isEmpty) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
        No execution data for this period
      </div>
    );
  }

  return (
    <ResponsiveContainer height={300} width="100%">
      <AreaChart data={chartData}>
        <CartesianGrid className="stroke-border" strokeDasharray="3 3" />
        <XAxis
          axisLine={false}
          className="text-xs"
          dataKey="timestamp"
          minTickGap={24}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickFormatter={(value: string) => formatTimestamp(value, intervalMs)}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          className="text-xs"
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickLine={false}
          width={40}
        />
        <RechartsTooltip
          content={<ChartTooltip intervalMs={intervalMs} />}
          cursor={{ stroke: "hsl(var(--muted-foreground) / 0.3)" }}
        />
        {activeKeys.map((key) => (
          <Area
            dataKey={key}
            fill={CHART_COLORS[key]}
            fillOpacity={0.4}
            key={key}
            stroke="none"
            type="monotone"
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TimeSeriesChart(): ReactNode {
  const timeSeries = useAtomValue(analyticsTimeSeriesAtom);
  const intervalMs = useAtomValue(analyticsTimeSeriesIntervalAtom);
  const loading = useAtomValue(analyticsLoadingAtom);

  const chartData = useMemo(
    () =>
      timeSeries.map((bucket) => ({
        ...bucket,
        timestamp: bucket.timestamp,
      })),
    [timeSeries]
  );

  const isReady = !(loading && chartData.length === 0);

  return (
    <Card data-ready={String(isReady)} data-testid="time-series-chart">
      <CardHeader>
        <CardTitle>Execution Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <TimeSeriesContent
          chartData={chartData}
          intervalMs={intervalMs}
          loading={loading}
        />
      </CardContent>
    </Card>
  );
}
