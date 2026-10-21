"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SETTINGS_MENU_PATH } from "./nav";
import { SettingsAccessGate } from "./settings-access-gate";
import { SettingsRail } from "./settings-rail";

/**
 * On a phone the rail gives way to the settings menu, so a section leads back
 * to it from a bar that stays at the top while it scrolls.
 *
 * "A phone" is below Tailwind's md everywhere here, the app's own phone
 * breakpoint (the header's menu button): the rail's max-md:hidden, this bar's
 * md:hidden, the menu page's md:hidden and BELOW_MD_QUERY, the plan
 * comparison's phone scroll in app/globals.css, and the two ways in that
 * lead phones to the menu: the header drawer's Settings (the drawer itself
 * is md:hidden) and the user menu's settings button (useIsMobile). They move
 * together, or a window between them has no way round settings.
 */
function SettingsBackBar(): React.ReactElement {
  return (
    <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center border-b bg-background px-1 md:hidden">
      <Link
        className="flex h-11 items-center gap-1 rounded-md pr-3 pl-2 font-medium text-sm transition-colors hover:bg-muted"
        data-testid="settings-back-to-menu"
        href={SETTINGS_MENU_PATH}
      >
        <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
        Settings
      </Link>
    </div>
  );
}

export function SettingsShell({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  // The plan cards are a four-column grid built for a full page; the reading
  // width every other section wants would crush them into each other.
  const wide = pathname.endsWith("/plans");
  const menu = pathname === SETTINGS_MENU_PATH;

  return (
    <div
      className="pointer-events-auto fixed inset-x-0 bottom-0 flex flex-col bg-background"
      data-testid="settings-shell"
      // Sits directly under the shared app toolbar, which is fixed at the top
      // of every route.
      style={{
        top: "calc(var(--header-height, 60px) + var(--app-banner-height, 0px))",
      }}
    >
      <div className="flex min-h-0 flex-1">
        <SettingsRail />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {!menu && <SettingsBackBar />}
          {/* A container, so a section lays itself out by the room it has
              beside the rail rather than by the width of the screen. */}
          <div
            className={cn(
              "@container/settings mx-auto flex w-full flex-col gap-4 px-4 py-5 md:gap-6 md:px-6 md:py-8 lg:px-8",
              wide ? "max-w-7xl" : "max-w-5xl"
            )}
          >
            <SettingsAccessGate>{children}</SettingsAccessGate>
          </div>
        </main>
      </div>
    </div>
  );
}
