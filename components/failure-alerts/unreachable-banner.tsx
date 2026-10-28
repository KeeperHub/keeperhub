"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";

/**
 * Top-of-app warning that nobody in the organization would hear about a
 * failing workflow: no member has an email KeeperHub can reach (wallet-only
 * accounts without a verified email) and no chat or PagerDuty channel works.
 *
 * Not dismissible. It goes away the moment someone adds an email or a
 * channel, which is the only way to fix what it describes.
 */
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
        <span className="truncate">
          You will not be told if a workflow keeps failing: add an email or a
          Telegram, Discord, Slack or PagerDuty channel.{" "}
          <Link
            className="font-medium underline underline-offset-4"
            href={`/settings/${organizationId}/notifications`}
          >
            Notification settings
          </Link>
        </span>
      </p>
    </output>
  );
}
