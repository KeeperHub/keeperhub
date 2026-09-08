"use client";

import { useAtomValue } from "jotai";
import { BarChart3, DollarSign } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { FullPageAuthGate } from "@/components/full-page-auth-gate";
import { Button } from "@/components/ui/button";
import { earningsDataAtom } from "@/lib/atoms/earnings";
import { useSession } from "@/lib/auth-client";
import { EarningsHeader } from "./earnings-header";
import { EarningsKpiCards } from "./earnings-kpi-cards";
import { useEarnings } from "./use-earnings";
import { WorkflowEarningsTable } from "./workflow-earnings-table";

function AuthGate({ error }: { error: string }): ReactNode {
  return (
    <FullPageAuthGate
      error={error}
      icon={DollarSign}
      orgDescription="Create or join an organization to start tracking workflow earnings."
      signInDescription="Sign in to your account to access your earnings dashboard."
      signInTitle="Sign in to view earnings"
    />
  );
}

function NoListedWorkflowsState(): ReactNode {
  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
            <BarChart3 className="size-10 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">
              No listed workflows yet
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              List a workflow to start earning. Agents can discover and pay to
              call your workflows.
            </p>
          </div>
          <Button asChild>
            <Link href="/">List a Workflow</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EarningsPage(): ReactNode {
  const { data: session, isPending } = useSession();
  const { loading, error, refetch, page, setPage } = useEarnings();
  const data = useAtomValue(earningsDataAtom);
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
        // auth-triggered refetch errors handled in useEarnings
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

  if (!loading && data !== null && !data.hasListedWorkflows) {
    return <NoListedWorkflowsState />;
  }

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <EarningsHeader onRefetch={refetch} />
          <EarningsKpiCards />
          <WorkflowEarningsTable onPageChange={setPage} page={page} />
        </div>
      </div>
    </div>
  );
}
