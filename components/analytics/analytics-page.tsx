"use client";

import { useAtomValue } from "jotai";
import { BarChart3 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { FullPageAuthGate } from "@/components/full-page-auth-gate";
import {
  analyticsProjectIdAtom,
  analyticsSummaryAtom,
} from "@/lib/atoms/analytics";
import { useSession } from "@/lib/auth-client";
import { AnalyticsHeader } from "./analytics-header";
import { EmptyState } from "./empty-state";
import { KpiCards } from "./kpi-cards";
import { RunsFilters } from "./runs-filters";
import { RunsTable } from "./runs-table";
import { TimeSeriesChart } from "./time-series-chart";
import { useAnalytics } from "./use-analytics";

function AuthGate({ error }: { error: string }): ReactNode {
  return (
    <FullPageAuthGate
      error={error}
      icon={BarChart3}
      orgDescription="Create or join an organization to start tracking workflow executions."
      signInDescription="Sign in to your account to access execution analytics and gas tracking."
      signInTitle="Sign in to view analytics"
    />
  );
}

export function AnalyticsPage(): ReactNode {
  const { data: session, isPending } = useSession();
  const { loading, error, refetch } = useAnalytics();
  const summary = useAtomValue(analyticsSummaryAtom);
  const projectId = useAtomValue(analyticsProjectIdAtom);
  const prevErrorRef = useRef<string | null>(null);

  useEffect(() => {
    const isAuthError = error === "AUTH_REQUIRED" || error === "ORG_REQUIRED";
    if (error && !isAuthError && error !== prevErrorRef.current) {
      toast.error(error);
    }
    prevErrorRef.current = error;
  }, [error]);

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

  if (isPending) {
    return null;
  }

  const isAnonymous = !session?.user || session.user.isAnonymous;
  if (isAnonymous || error === "AUTH_REQUIRED") {
    return <AuthGate error="AUTH_REQUIRED" />;
  }

  if (error === "ORG_REQUIRED") {
    return <AuthGate error={error} />;
  }

  const hasNoData =
    projectId === null &&
    summary !== null &&
    summary.totalRuns === 0 &&
    summary.activeRuns === 0;

  if (hasNoData && !loading) {
    return (
      <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
        <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
          <div className="flex flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
            <AnalyticsHeader onRefetch={refetch} />
            <EmptyState />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <AnalyticsHeader onRefetch={refetch} />

          <KpiCards />
          <TimeSeriesChart />

          <RunsFilters />
          <RunsTable />
        </div>
      </div>
    </div>
  );
}
