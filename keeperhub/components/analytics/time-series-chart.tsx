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
import type { TimeRange } from "@/keeperhub/lib/analytics/types";
import {
  analyticsLoadingAtom,
  analyticsRangeAtom,
  analyticsTimeSeriesAtom,
} from "@/keeperhub/lib/atoms/analytics";

const CHART_COLORS = {
  success: "var(--color-keeperhub-green)",
  error: "var(--chart-1)",
  running: "var(--chart-2)",
  pending: "var(--chart-3)",
} as const;

function formatTimestamp(value: string, range: TimeRange): string {
  const date = new Date(value);

  if (range === "1h" || range === "24h") {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTooltipTimestamp(value: string): string {
  const date = new Date(value);
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
};

function ChartTooltip({
  active,
  payload,
  label,
}: CustomTooltipProps): ReactNode {
  if (!(active && payload?.length && label)) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">
        {formatTooltipTimestamp(label)}
      </p>
      {payload.map((entry) => (
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
  range,
  loading,
}: {
  chartData: {
    timestamp: string;
    success: number;
    error: number;
    pending: number;
    running: number;
  }[];
  range: TimeRange;
  loading: boolean;
}): ReactNode {
  const isEmpty = chartData.length === 0;

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
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickFormatter={(value: string) => formatTimestamp(value, range)}
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
          content={<ChartTooltip />}
          cursor={{ stroke: "hsl(var(--muted-foreground) / 0.3)" }}
        />
        <Area
          dataKey="success"
          fill={CHART_COLORS.success}
          fillOpacity={0.4}
          stackId="executions"
          stroke={CHART_COLORS.success}
          type="monotone"
        />
        <Area
          dataKey="error"
          fill={CHART_COLORS.error}
          fillOpacity={0.4}
          stackId="executions"
          stroke={CHART_COLORS.error}
          type="monotone"
        />
        <Area
          dataKey="running"
          fill={CHART_COLORS.running}
          fillOpacity={0.4}
          stackId="executions"
          stroke={CHART_COLORS.running}
          type="monotone"
        />
        <Area
          dataKey="pending"
          fill={CHART_COLORS.pending}
          fillOpacity={0.4}
          stackId="executions"
          stroke={CHART_COLORS.pending}
          type="monotone"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TimeSeriesChart(): ReactNode {
  const timeSeries = useAtomValue(analyticsTimeSeriesAtom);
  const range = useAtomValue(analyticsRangeAtom);
  const loading = useAtomValue(analyticsLoadingAtom);

  const chartData = useMemo(
    () =>
      timeSeries.map((bucket) => ({
        ...bucket,
        timestamp: bucket.timestamp,
      })),
    [timeSeries]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <TimeSeriesContent
          chartData={chartData}
          loading={loading}
          range={range}
        />
      </CardContent>
    </Card>
  );
}
