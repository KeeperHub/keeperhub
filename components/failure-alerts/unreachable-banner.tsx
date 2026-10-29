"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";

/** Top-of-app warning that nobody can be told of a failure; not dismissible, as fixing it is the only way out. */
export function FailureAlertsUnreachableBanner({
  organizationId,
}: {
  organizationId: string;
}): React.ReactElement {
  return (
    <output
      className="pointer-events-auto fixed top-0 right-0 left-0 z-[55] flex h-9 items-center justify-center border-destructive/50 border-b bg-destructive/25 px-4 text-foreground text-sm backdrop-blur-sm sm:px-12"
      data-testid="failure-alerts-unreachable-banner"
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
    </output>
  );
}
