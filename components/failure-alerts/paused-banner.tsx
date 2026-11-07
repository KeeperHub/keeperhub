"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { AppBannerSlot } from "@/components/app-banner-slot";
import { NOTICE_TONE_CLASS } from "@/components/ui/notice";
import {
  PAUSE_HEADLINE,
  pausedFor,
  pauseEffect,
} from "@/lib/notifications/failure-alerts/pause-copy";
import { cn } from "@/lib/utils";
import { formatWhen, TOUCH_TARGET } from "./format";

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
      className={cn(NOTICE_TONE_CLASS.warning, "px-4 sm:px-12")}
      data-testid="failure-alerts-paused-banner"
      role="status"
    >
      <p className="flex min-w-0 items-center gap-2">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          {/* Short below laptop width and on short (landscape) screens. */}
          <span className="lg:hidden [@media(max-height:500px)]:inline">
            {PAUSE_HEADLINE.paused} until {formatWhen(until)}.
          </span>
          <span className="hidden lg:inline [@media(max-height:500px)]:hidden">
            {pausedFor("org")} until {formatWhen(until)}. {pauseEffect("org")}.
          </span>
        </span>
        {/* Outside the truncated text, so the way to resume never gets cut. */}
        <Link
          className={`shrink-0 font-medium underline underline-offset-4 ${TOUCH_TARGET}`}
          href={`/settings/${organizationId}/alerts`}
        >
          Open Alerts
        </Link>
      </p>
    </AppBannerSlot>
  );
}
