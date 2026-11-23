"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type SettingsNavItem, settingsHref } from "./nav";

/**
 * A link to a settings section (and, with `suffix`, to a card in it). An
 * org-scoped section's path carries the organization; until that has loaded
 * the path would have none, and /settings/users reads "users" as an org id
 * and bounces back out. So the row waits, dimmed and without a hover, until it
 * can go. Once the session resolves with no organization the nav leaves these
 * rows out instead (see isSettingsItemVisible).
 */
export function SettingsLink({
  item,
  organizationId,
  suffix = "",
  prefetch = false,
  className,
  children,
  ...attributes
}: {
  item: SettingsNavItem;
  organizationId: string | null;
  suffix?: string;
  /** Fetch the section's code ahead of the click (the nav lists do). */
  prefetch?: boolean;
  className: string;
  children: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
  "data-testid"?: string;
}): React.ReactElement {
  if (item.scope === "org" && !organizationId) {
    return (
      <span
        aria-disabled="true"
        className={cn(className, "pointer-events-none opacity-50")}
        {...attributes}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      className={className}
      href={`${settingsHref(item, organizationId)}${suffix}`}
      prefetch={prefetch || undefined}
      {...attributes}
    >
      {children}
    </Link>
  );
}
