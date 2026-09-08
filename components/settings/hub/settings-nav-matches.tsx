"use client";

import Link from "next/link";
import { findSettingsMatches, settingsAnchor, settingsHref } from "./nav";
import { useSettingsContext } from "./settings-context";

/**
 * The rail while searching: only sections that match stay, and each one lists
 * the settings inside it that matched, so the exact one is one click away.
 */
export function SettingsNavMatches({
  query,
}: {
  query: string;
}): React.ReactElement {
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
            className="flex h-9 items-center gap-3 rounded-md px-2 font-medium text-sm transition-colors hover:bg-muted"
            data-testid={`settings-match-${item.segment}`}
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
                  className="flex h-8 items-center rounded-md px-2 text-sm transition-colors hover:bg-muted"
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
