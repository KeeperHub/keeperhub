"use client";

import { ChevronRight } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useUserInvitations } from "./hooks/use-user-invitations";
import {
  isSettingsItemActive,
  isSettingsItemVisible,
  SETTINGS_NAV,
} from "./nav";
import { useSettingsContext } from "./settings-context";
import { SettingsLink } from "./settings-link";

const ROW =
  "flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-muted";

// The phone menu: each group a card of full-width rows, tall enough to tap.
export const MENU_CARD =
  "flex flex-col overflow-hidden rounded-xl border bg-card/60";
export const MENU_ROW =
  "flex h-12 items-center gap-3 border-t px-3.5 text-base transition-colors first:border-t-0 hover:bg-muted/50";

export function SettingsNavList({
  variant = "rail",
}: {
  /** "menu" is the phone's settings menu, which stands in for the rail. */
  variant?: "rail" | "menu";
}): React.ReactElement {
  const pathname = usePathname();
  const { isAdmin, isOwner, organizationId } = useSettingsContext();
  const { invitations } = useUserInvitations();
  const menu = variant === "menu";

  const groups = SETTINGS_NAV.map((group) => ({
    items: group.items.filter((item) =>
      isSettingsItemVisible(item, { isAdmin, isOwner })
    ),
    label: group.label,
  })).filter((group) => group.items.length > 0);

  return (
    <>
      {groups.map((group) => (
        <div
          className={cn("flex flex-col", menu ? "gap-1.5" : "gap-0.5")}
          key={group.label}
        >
          <p
            className={cn(
              "font-medium text-muted-foreground text-xs uppercase tracking-wider",
              menu ? "px-1" : "px-2 pt-3 pb-1"
            )}
          >
            {group.label}
          </p>
          <div className={menu ? MENU_CARD : "contents"}>
            {group.items.map((item) => {
              const active = !menu && isSettingsItemActive(item, pathname);
              return (
                <SettingsLink
                  aria-current={active ? "page" : undefined}
                  aria-label={item.label}
                  className={cn(menu ? MENU_ROW : ROW, active && "bg-muted")}
                  data-testid={`settings-${menu ? "menu" : "nav"}-${item.segment}`}
                  item={item}
                  key={item.segment}
                  organizationId={organizationId}
                  // Sections are dynamic routes, so their code is not fetched
                  // until asked for; prefetching keeps the click instant.
                  prefetch
                >
                  <item.icon className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.segment === "account" && invitations.length > 0 && (
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-[0.625rem] text-primary-foreground"
                      title={`${invitations.length} invitations waiting on you`}
                    >
                      {invitations.length}
                    </span>
                  )}
                  {menu && (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </SettingsLink>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
