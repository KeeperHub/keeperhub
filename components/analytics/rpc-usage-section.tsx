"use client";

import { useAtomValue } from "jotai";
import {
  Activity,
  ArrowLeftRight,
  Gauge,
  Server,
  TriangleAlert,
} from "lucide-react";
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
import {
  KEEPERHUB_ENDPOINT_LABEL,
  rpcEndpointLabel,
  shareOf,
} from "@/lib/analytics/rpc-usage-shape";
import type {
  RpcOwnOnlyChainUsage,
  RpcUsageBreakdownRow,
  RpcUsageBucket,
  RpcUsageResponse,
  RpcUsageSummary,
} from "@/lib/analytics/types";
import {
  analyticsLoadingAtom,
  analyticsProjectIdAtom,
  analyticsRpcUsageAtom,
} from "@/lib/atoms/analytics";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  KpiCard,
  type KpiCardProps,
  SkeletonCard,
} from "./kpi-cards";
import {
  ChartSkeleton,
  ChartTooltip,
  formatTimestamp,
} from "./time-series-chart";

const OWN_SERIES_LABEL = "Your endpoints";

const SERIES = [
  { key: "ownRequests", name: OWN_SERIES_LABEL, color: "var(--chart-2)" },
  {
    key: "platformRequests",
    name: KEEPERHUB_ENDPOINT_LABEL,
    color: "var(--chart-1)",
  },
] as const;

const KPI_COUNT = 5;

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatShare(share: number | null): string {
  return share === null ? "-" : `${(share * 100).toFixed(1)}%`;
}

type RpcKpi = Omit<KpiCardProps, "delta">;

function buildKpis(summary: RpcUsageSummary): RpcKpi[] {
  const ownShare = shareOf(summary.ownRequests, summary.requests);
  const platformShare = shareOf(summary.platformRequests, summary.requests);
  return [
    {
      cardKey: "rpc-requests",
      icon: <Activity className="size-5" />,
      label: "RPC requests",
      value: formatCount(summary.requests),
      breakdown: [
        {
          key: "own",
          text: `${formatCount(summary.ownRequests)} on your endpoints`,
        },
        {
          key: "platform",
          text: `${formatCount(summary.platformRequests)} on KeeperHub`,
        },
      ],
    },
    {
      cardKey: "rpc-own-share",
      icon: <Server className="size-5" />,
      label: "On your endpoints",
      value: formatShare(ownShare),
      breakdown: [
        { key: "platform", text: `${formatShare(platformShare)} on KeeperHub` },
      ],
    },
    {
      cardKey: "rpc-error-rate",
      icon: <TriangleAlert className="size-5" />,
      label: "Error rate",
      value: formatShare(shareOf(summary.errors, summary.requests)),
      breakdown: [
        { key: "errors", text: `${formatCount(summary.errors)} errors` },
        { key: "timeouts", text: `${formatCount(summary.timeouts)} timeouts` },
        {
          key: "rate-limited",
          text: `${formatCount(summary.rateLimited)} rate limited`,
        },
      ],
    },
    {
      cardKey: "rpc-failovers",
      icon: <ArrowLeftRight className="size-5" />,
      label: "Failovers",
      value: formatCount(summary.failovers),
      tooltip: "Times a request moved from a primary endpoint to its fallback.",
    },
    {
      cardKey: "rpc-latency",
      icon: <Gauge className="size-5" />,
      label: "Avg latency",
      value: formatDuration(summary.avgLatencyMs),
      breakdown: [
        { key: "max", text: `Max ${formatDuration(summary.maxLatencyMs)}` },
      ],
    },
  ];
}

function OwnRpcOnlyLine({ chain }: { chain: RpcOwnOnlyChainUsage }): ReactNode {
  const count = chain.platformRequests;
  return (
    <li
      className={cn(
        "text-sm",
        count > 0 ? "font-medium text-destructive" : "text-muted-foreground"
      )}
      data-chain-id={chain.chainId}
      data-platform-requests={count}
      data-testid="rpc-own-only-line"
    >
      {chain.chainName ?? `Chain ${chain.chainId}`} uses your endpoints only.
      KeeperHub RPC requests on it in this range: {formatCount(count)}
    </li>
  );
}

function RequestsChart({
  buckets,
  intervalMs,
}: {
  buckets: RpcUsageBucket[];
  intervalMs: number;
}): ReactNode {
  return (
    <ResponsiveContainer height={260} width="100%">
      <AreaChart data={buckets}>
        <CartesianGrid className="stroke-border" strokeDasharray="3 3" />
        <XAxis
          axisLine={false}
          dataKey="timestamp"
          minTickGap={24}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickFormatter={(value: string) => formatTimestamp(value, intervalMs)}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
          tickLine={false}
          width={48}
        />
        <RechartsTooltip
          content={<ChartTooltip intervalMs={intervalMs} />}
          cursor={{ stroke: "var(--color-border)" }}
        />
        {SERIES.map((series) => (
          <Area
            dataKey={series.key}
            fill={series.color}
            fillOpacity={0.4}
            key={series.key}
            name={series.name}
            stackId="requests"
            stroke={series.color}
            type="monotone"
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ChartLegend(): ReactNode {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      {SERIES.map((series) => (
        <span className="flex items-center gap-1.5" key={series.key}>
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: series.color }}
          />
          {series.name}
        </span>
      ))}
    </div>
  );
}

function breakdownRowKey(row: RpcUsageBreakdownRow): string {
  return `${row.origin}:${row.configId ?? ""}:${row.chainId}`;
}

function BreakdownTable({ rows }: { rows: RpcUsageBreakdownRow[] }): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-160 text-left"
        data-testid="rpc-usage-breakdown"
      >
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">Endpoint</th>
            <th className="pb-2 pr-3 font-medium">Chain</th>
            <th className="pb-2 pr-3 text-right font-medium">Requests</th>
            <th className="pb-2 pr-3 text-right font-medium">Errors</th>
            <th className="pb-2 pr-3 text-right font-medium">Failovers</th>
            <th className="pb-2 pr-3 text-right font-medium">Avg latency</th>
            <th className="pb-2 pr-3 text-right font-medium">Max latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className="border-b border-muted text-sm last:border-0"
              data-config-removed={String(row.configRemoved)}
              data-origin={row.origin}
              key={breakdownRowKey(row)}
            >
              <td
                className={cn(
                  "py-2 pr-3",
                  row.configRemoved && "text-muted-foreground italic"
                )}
              >
                {rpcEndpointLabel(row)}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {row.chainName ?? String(row.chainId)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatCount(row.requests)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatCount(row.errors)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatCount(row.failovers)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatDuration(row.avgLatencyMs)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatDuration(row.maxLatencyMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function hasAnyUsage(usage: RpcUsageResponse): boolean {
  const { summary } = usage;
  return (
    summary.requests > 0 || summary.wsConnects > 0 || summary.eventsReceived > 0
  );
}

function RpcUsageBody({ usage }: { usage: RpcUsageResponse }): ReactNode {
  const kpis = useMemo(() => buildKpis(usage.summary), [usage.summary]);

  if (!hasAnyUsage(usage)) {
    return (
      <Card data-testid="rpc-usage-empty">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No RPC requests in this range
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => (
          <KpiCard delta={null} key={kpi.cardKey} {...kpi} />
        ))}
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Requests by endpoint</CardTitle>
          <ChartLegend />
        </CardHeader>
        <CardContent>
          <RequestsChart
            buckets={usage.buckets}
            intervalMs={usage.intervalMs}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Endpoints and chains</CardTitle>
        </CardHeader>
        <CardContent>
          <BreakdownTable rows={usage.breakdown} />
        </CardContent>
      </Card>
    </>
  );
}

function RpcUsageSkeleton(): ReactNode {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: KPI_COUNT }, (_, index) => (
          <SkeletonCard key={`rpc-skeleton-${String(index)}`} />
        ))}
      </div>
      <Card>
        <CardContent>
          <ChartSkeleton />
        </CardContent>
      </Card>
    </>
  );
}

export function RpcUsageSection(): ReactNode {
  const usage = useAtomValue(analyticsRpcUsageAtom);
  const loading = useAtomValue(analyticsLoadingAtom);
  const projectId = useAtomValue(analyticsProjectIdAtom);

  if (!(usage || loading)) {
    return null;
  }

  return (
    <section
      className="flex flex-col gap-4"
      data-ready={String(usage !== null)}
      data-testid="rpc-usage"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">RPC usage</h2>
        <p className="text-sm text-muted-foreground">
          Requests made for your workflows and executions, by the endpoint that
          served them.
          {projectId
            ? " These figures cover the whole organization: RPC usage is not split by project."
            : null}
        </p>
        {usage && usage.ownRpcOnlyChains.length > 0 ? (
          <ul className="space-y-1">
            {usage.ownRpcOnlyChains.map((chain) => (
              <OwnRpcOnlyLine chain={chain} key={chain.chainId} />
            ))}
          </ul>
        ) : null}
      </div>
      {usage ? <RpcUsageBody usage={usage} /> : <RpcUsageSkeleton />}
    </section>
  );
}
