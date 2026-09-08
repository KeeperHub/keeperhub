"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useUserInvitations } from "./hooks/use-user-invitations";
import {
  isSettingsItemActive,
  isSettingsItemVisible,
  SETTINGS_NAV,
  settingsHref,
} from "./nav";
import { useSettingsContext } from "./settings-context";

const ROW =
  "flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-muted";

export function SettingsNavList(): React.ReactElement {
  const pathname = usePathname();
  const { isAdmin, isOwner, organizationId } = useSettingsContext();
  const { invitations } = useUserInvitations();

  const groups = SETTINGS_NAV.map((group) => ({
    items: group.items.filter((item) =>
      isSettingsItemVisible(item, { isAdmin, isOwner })
    ),
    label: group.label,
  })).filter((group) => group.items.length > 0);

  return (
    <>
      {groups.map((group) => (
        <div className="flex flex-col gap-0.5" key={group.label}>
          <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active = isSettingsItemActive(item, pathname);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                className={cn(ROW, active && "bg-muted")}
                data-testid={`settings-nav-${item.segment}`}
                href={settingsHref(item, organizationId)}
                key={item.segment}
                // Sections are dynamic routes, so their code is not fetched
                // until asked for; prefetching keeps the click instant.
                prefetch
              >
                <item.icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.segment === "account" && invitations.length > 0 && (
                  <span
                    className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-[0.625rem] text-primary-foreground"
                    title={`${invitations.length} invitations waiting on you`}
                  >
                    {invitations.length}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}
