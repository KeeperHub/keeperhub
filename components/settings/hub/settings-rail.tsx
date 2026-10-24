"use client";

import { ArrowLeft, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useExitPath } from "./hooks/use-exit-path";
import { RAIL_WIDTH } from "./hooks/use-rail-width";
import { MENU_CARD, MENU_ROW, SettingsNavList } from "./settings-nav-list";
import { SettingsNavMatches } from "./settings-nav-matches";
import { SettingsSearch } from "./settings-search";

const LINKS = [
  {
    href: "https://discord.gg/keeperhub",
    icon: DiscordIcon,
    label: "Join Discord",
  },
  {
    href: "https://docs.keeperhub.com",
    icon: Info,
    label: "Documentation",
  },
] as const;

/** Discord and the docs, at the foot of the rail and of the phone menu. */
export function SettingsLinks({
  variant = "rail",
}: {
  /** "menu" is the phone's settings menu: a card of tap-sized rows. */
  variant?: "rail" | "menu";
}): React.ReactElement {
  const menu = variant === "menu";
  return (
    <div
      className={
        menu ? MENU_CARD : "flex shrink-0 flex-col gap-1 border-t px-2.5 py-3"
      }
    >
      {LINKS.map((item) => (
        <a
          className={
            menu
              ? MENU_ROW
              : "flex h-9 w-full items-center gap-3 rounded-md px-2 transition-colors hover:bg-muted"
          }
          href={item.href}
          key={item.label}
          rel="noopener"
          target="_blank"
        >
          <item.icon className="size-4 shrink-0" />
          <span className={cn("truncate", !menu && "text-sm")}>
            {item.label}
          </span>
        </a>
      ))}
    </div>
  );
}

export function SettingsRail(): React.ReactElement {
  const [query, setQuery] = useState("");
  const exitPath = useExitPath();
  const searching = query.trim().length > 0;

  return (
    <aside
      aria-label="Settings navigation"
      // A phone has the settings menu (the index page) in its place.
      className="relative flex shrink-0 flex-col border-r bg-background max-md:hidden"
      data-testid="settings-rail"
      style={{ width: RAIL_WIDTH }}
    >
      <div className="flex shrink-0 items-center border-b px-2.5 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Leave settings"
              asChild
              className="h-8 gap-2 px-2"
              size="sm"
              variant="ghost"
            >
              <Link href={exitPath}>
                <ArrowLeft className="size-4 shrink-0" />
                <span className="truncate">Back</span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Back to {exitPath}</TooltipContent>
        </Tooltip>
      </div>

      <SettingsSearch onQueryChange={setQuery} query={query} />

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-2 pb-4">
        {searching ? <SettingsNavMatches query={query} /> : <SettingsNavList />}
      </nav>

      <SettingsLinks />
    </aside>
  );
}
