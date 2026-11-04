"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { AppBannerSlot } from "@/components/app-banner-slot";

/** Top-of-app warning that nobody can be told of a failure; not dismissible, as fixing it is the only way out. */
export function FailureAlertsUnreachableBanner({
  organizationId,
}: {
  organizationId: string;
}): React.ReactElement {
  return (
    <AppBannerSlot
      className="border-destructive/50 bg-destructive/25 px-4 text-foreground sm:px-12"
      data-testid="failure-alerts-unreachable-banner"
      role="status"
    >
      <p className="flex min-w-0 items-center gap-2">
        <AlertTriangle
          aria-hidden="true"
          className="size-4 shrink-0 text-destructive"
        />
        <span className="min-w-0 truncate">
          <span className="sm:hidden">Nobody gets alerts.</span>
          <span className="hidden sm:inline">
            Nobody will be told when a workflow fails.
          </span>
        </span>
        {/* Outside the truncated text, so the way to fix it never gets cut. */}
        <Link
          className="shrink-0 font-medium underline underline-offset-4"
          href={`/settings/${organizationId}/alerts?highlight=methods`}
        >
          <span className="sm:hidden">Fix</span>
          <span className="hidden sm:inline">Fix in Alerts</span>
        </Link>
      </p>
    </AppBannerSlot>
  );
}
