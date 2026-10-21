"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { findSettingsMatches, settingsAnchor, settingsHref } from "./nav";
import { useSettingsContext } from "./settings-context";

/**
 * The rail while searching: only sections that match stay, and each one lists
 * the settings inside it that matched, so the exact one is one click away.
 */
export function SettingsNavMatches({
  query,
  variant = "rail",
}: {
  query: string;
  /** "menu" is the phone's settings menu: the same list, tap-sized. */
  variant?: "rail" | "menu";
}): React.ReactElement {
  const menu = variant === "menu";
  const { isAdmin, isOwner, organizationId } = useSettingsContext();
  const matches = findSettingsMatches(query, { isAdmin, isOwner });

  if (matches.length === 0) {
    return (
      <p className="px-2 py-4 text-muted-foreground text-sm">
        No settings match that.
      </p>
    );
  }

  return (
    <>
      {matches.map(({ item, panels }) => (
        <div className="flex flex-col gap-0.5" key={item.segment}>
          <Link
            className={cn(
              "flex items-center gap-3 rounded-md px-2 font-medium transition-colors hover:bg-muted",
              menu ? "h-11 text-base" : "h-9 text-sm"
            )}
            data-testid={`settings-${menu ? "menu-match" : "match"}-${item.segment}`}
            href={settingsHref(item, organizationId)}
          >
            <item.icon className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
          {panels.length > 0 && (
            // Indent the row box itself, not just its text, so the hover fill
            // reads as an inner element rather than another top-level row. The
            // rule down the left ties the entries to their section.
            <div className="ml-4 flex flex-col gap-0.5 border-border/60 border-l pl-1.5">
              {panels.map((panel) => (
                <Link
                  className={cn(
                    "flex items-center rounded-md px-2 transition-colors hover:bg-muted",
                    menu ? "h-11 text-base" : "h-8 text-sm"
                  )}
                  href={`${settingsHref(item, organizationId)}?highlight=${settingsAnchor(panel.title)}`}
                  key={panel.title}
                >
                  <span className="truncate">{panel.title}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
