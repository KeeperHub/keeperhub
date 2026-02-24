"use client";

import { useAtomValue } from "jotai";
import { BarChart3, LogIn } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { analyticsSummaryAtom } from "@/keeperhub/lib/atoms/analytics";
import { useSession } from "@/lib/auth-client";
import { AnalyticsHeader } from "./analytics-header";
import { EmptyState } from "./empty-state";
import { KpiCards } from "./kpi-cards";
import { RunsFilters } from "./runs-filters";
import { RunsTable } from "./runs-table";
import { TimeSeriesChart } from "./time-series-chart";
import { useAnalytics } from "./use-analytics";

function AuthGate({ error }: { error: string }): ReactNode {
  const isAuthRequired = error === "AUTH_REQUIRED";

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
            {isAuthRequired ? (
              <LogIn className="size-10 text-muted-foreground" />
            ) : (
              <BarChart3 className="size-10 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {isAuthRequired
                ? "Sign in to view analytics"
                : "Organization required"}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {isAuthRequired
                ? "Sign in to your account to access execution analytics and gas tracking."
                : "Create or join an organization to start tracking workflow executions."}
            </p>
          </div>
          {!isAuthRequired && (
            <Button asChild>
              <Link href="/">Get Started</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsPage(): ReactNode {
  const { data: session } = useSession();
  const { loading, error, refetch } = useAnalytics();
  const summary = useAtomValue(analyticsSummaryAtom);

  useEffect(() => {
    if (
      session?.user &&
      (error === "AUTH_REQUIRED" || error === "ORG_REQUIRED")
    ) {
      refetch().catch(() => {
        // auth-triggered refetch errors handled in useAnalytics
      });
    }
  }, [session, error, refetch]);

  if (error === "AUTH_REQUIRED" || error === "ORG_REQUIRED") {
    return <AuthGate error={error} />;
  }

  // Show a neutral loading state until the first fetch completes,
  // so the analytics skeleton doesn't flash before an auth error.
  if (summary === null && !error) {
    return (
      <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
        <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
          <div className="flex min-h-[60vh] items-center justify-center">
            <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

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

          <RunsFilters />
          <RunsTable />
        </div>
      </div>
    </div>
  );
}
