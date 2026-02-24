"use client";

import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  analyticsLoadingAtom,
  analyticsNetworksAtom,
} from "@/keeperhub/lib/atoms/analytics";

const BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

function formatGasAsEth(weiString: string): string {
  const wei = Number(weiString);
  if (Number.isNaN(wei) || wei === 0) {
    return "0 ETH";
  }
  const eth = wei / 1e18;
  return `${eth.toFixed(4)} ETH`;
}

type ChartDatum = {
  network: string;
  gasEth: number;
  gasWei: string;
  executions: number;
  successCount: number;
  errorCount: number;
};

type TooltipPayloadEntry = {
  payload: ChartDatum;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
};

function ChartTooltip({ active, payload }: CustomTooltipProps): ReactNode {
  if (!(active && payload?.length)) {
    return null;
  }

  const data = payload[0].payload;

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="mb-1 text-sm font-medium">{data.network}</p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>Gas: {formatGasAsEth(data.gasWei)}</p>
        <p>Executions: {data.executions}</p>
        <p>Success: {data.successCount}</p>
        <p>Errors: {data.errorCount}</p>
      </div>
    </div>
  );
}

function ChartSkeleton(): ReactNode {
  return (
    <div className="flex h-[250px] items-center justify-center">
      <div className="h-full w-full animate-pulse rounded bg-muted" />
    </div>
  );
}

function GasChartContent({
  chartData,
  loading,
}: {
  chartData: ChartDatum[];
  loading: boolean;
}): ReactNode {
  const isEmpty = chartData.length === 0;

  if (loading && isEmpty) {
    return <ChartSkeleton />;
  }

  if (isEmpty) {
    return (
      <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
        No gas data for this period
      </div>
    );
  }

  return (
    <ResponsiveContainer height={250} width="100%">
      <BarChart data={chartData} layout="vertical">
        <CartesianGrid
          className="stroke-border"
          horizontal={false}
          strokeDasharray="3 3"
        />
        <XAxis
          axisLine={false}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickFormatter={(value: number) => `${value.toFixed(4)}`}
          tickLine={false}
          type="number"
        />
        <YAxis
          axisLine={false}
          dataKey="network"
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickLine={false}
          type="category"
          width={100}
        />
        <RechartsTooltip content={<ChartTooltip />} cursor={false} />
        <Bar dataKey="gasEth" radius={[0, 4, 4, 0]}>
          {chartData.map((entry, index) => (
            <Cell
              fill={BAR_COLORS[index % BAR_COLORS.length]}
              key={entry.network}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GasBreakdownChart(): ReactNode {
  const networks = useAtomValue(analyticsNetworksAtom);
  const loading = useAtomValue(analyticsLoadingAtom);

  const chartData = useMemo(
    (): ChartDatum[] =>
      networks.map((network) => ({
        network: network.network,
        gasEth: Number(network.totalGasWei) / 1e18,
        gasWei: network.totalGasWei,
        executions: network.executionCount,
        successCount: network.successCount,
        errorCount: network.errorCount,
      })),
    [networks]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gas by Network</CardTitle>
      </CardHeader>
      <CardContent>
        <GasChartContent chartData={chartData} loading={loading} />
      </CardContent>
    </Card>
  );
}
