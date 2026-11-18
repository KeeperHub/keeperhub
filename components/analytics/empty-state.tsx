"use client";

import { BarChart3 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ViewOnlyTooltip } from "@/components/organization/view-only-tooltip";
import { Button } from "@/components/ui/button";
import { useOrgAccess } from "@/lib/hooks/use-org-access";

export function EmptyState(): ReactNode {
  const { isViewer } = useOrgAccess();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
        <BarChart3 className="size-10 text-muted-foreground" />
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          No executions yet
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Run a workflow or make a direct execution to see analytics data appear
          here.
        </p>
      </div>

      {isViewer ? (
        <ViewOnlyTooltip isViewer>
          <Button disabled>Create Workflow</Button>
        </ViewOnlyTooltip>
      ) : (
        <Button asChild>
          <Link href="/">Create Workflow</Link>
        </Button>
      )}
    </div>
  );
}
