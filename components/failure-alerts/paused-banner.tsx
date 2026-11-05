"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { AppBannerSlot } from "@/components/app-banner-slot";
import { formatWhen } from "./format";

/** Top-of-app note that alerts are paused; it goes when the pause ends or someone resumes. */
export function FailureAlertsPausedBanner({
  organizationId,
  until,
}: {
  organizationId: string;
  until: string;
}): React.ReactElement {
  return (
    <AppBannerSlot
      className="border-yellow-500/40 bg-yellow-500/10 px-4 text-yellow-700 sm:px-12 dark:text-yellow-300"
      data-testid="failure-alerts-paused-banner"
      role="status"
    >
      <p className="flex min-w-0 items-center gap-2">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          <span className="sm:hidden">
            Alerts paused until {formatWhen(until)}.
          </span>
          <span className="hidden sm:inline">
            Alerts are paused until {formatWhen(until)}. Failures are not
            reported until then.
          </span>
        </span>
        {/* Outside the truncated text, so the way to resume never gets cut. */}
        <Link
          className="shrink-0 font-medium underline underline-offset-4"
          href={`/settings/${organizationId}/alerts`}
        >
          <span className="sm:hidden">Open</span>
          <span className="hidden sm:inline">Open Alerts</span>
        </Link>
      </p>
    </AppBannerSlot>
  );
}
