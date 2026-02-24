"use client";

import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { analyticsSummaryAtom } from "@/keeperhub/lib/atoms/analytics";
import { AnalyticsHeader } from "./analytics-header";
import { EmptyState } from "./empty-state";
import { GasBreakdownChart } from "./gas-breakdown-chart";
import { KpiCards } from "./kpi-cards";
import { RunsFilters } from "./runs-filters";
import { RunsTable } from "./runs-table";
import { SpendCapGauge } from "./spend-cap-gauge";
import { TimeSeriesChart } from "./time-series-chart";
import { useAnalytics } from "./use-analytics";

export function AnalyticsPage(): ReactNode {
  const { loading, error, refetch } = useAnalytics();
  const summary = useAtomValue(analyticsSummaryAtom);

  const hasNoData =
    summary !== null && summary.totalRuns === 0 && summary.activeRuns === 0;

  if (hasNoData && !loading) {
    return (
      <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
        <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
          <div className="flex flex-col gap-6 p-6 pt-20">
            <AnalyticsHeader onRefetch={refetch} />
            <EmptyState />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="flex flex-col gap-6 p-6 pt-20">
          <AnalyticsHeader onRefetch={refetch} />

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          ) : null}

          <KpiCards />
          <TimeSeriesChart />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <GasBreakdownChart />
            <SpendCapGauge />
          </div>

          <RunsFilters />
          <RunsTable />
        </div>
      </div>
    </div>
  );
}
