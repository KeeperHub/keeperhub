"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BELOW_MD_QUERY, useMediaQuery } from "@/hooks/use-mobile";
import { useExitPath } from "./hooks/use-exit-path";
import { SettingsNavList } from "./settings-nav-list";
import { SettingsNavMatches } from "./settings-nav-matches";
import { SETTINGS_LINKS } from "./settings-rail";
import { SettingsSearch } from "./settings-search";

const FIRST_SECTION = "/settings/account";

/**
 * The settings index. On a phone it is the menu the rail would be, full
 * width, and each section leads back to it. Wider screens have the rail
 * beside every section, so they go straight on to the first one.
 */
export function SettingsMenu(): React.ReactElement | null {
  const router = useRouter();
  const phone = useMediaQuery(BELOW_MD_QUERY);
  const exitPath = useExitPath();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  useEffect(() => {
    // Asked of the window, not read from `phone`: that is false while the
    // page hydrates, which would send a phone on too. Asked again when the
    // answer changes, e.g. a phone turned to a landscape tablet width.
    const list = window.matchMedia(BELOW_MD_QUERY);
    const goOnIfWide = (): void => {
      if (!list.matches) {
        router.replace(FIRST_SECTION);
      }
    };
    goOnIfWide();
    list.addEventListener("change", goOnIfWide);
    return () => list.removeEventListener("change", goOnIfWide);
  }, [router]);

  if (!phone) {
    return null;
  }

  return (
    <div className="flex flex-col gap-5" data-testid="settings-menu">
      <div className="-mt-2 -ml-2 flex">
        <Link
          className="flex h-11 items-center gap-2 rounded-md pr-3 pl-2 font-medium text-sm transition-colors hover:bg-muted"
          href={exitPath}
        >
          <ArrowLeft className="size-4 shrink-0" />
          Back
        </Link>
      </div>
      <h1 className="font-bold text-xl tracking-tight">Settings</h1>
      <SettingsSearch onQueryChange={setQuery} query={query} variant="menu" />
      <nav aria-label="Settings sections" className="flex flex-col gap-5">
        {searching ? (
          <SettingsNavMatches query={query} variant="menu" />
        ) : (
          <SettingsNavList variant="menu" />
        )}
      </nav>
      <div className="flex flex-col overflow-hidden rounded-xl border bg-card/60">
        {SETTINGS_LINKS.map((item) => (
          <a
            className="flex h-12 items-center gap-3 border-t px-3.5 text-base transition-colors first:border-t-0 hover:bg-muted/50"
            href={item.href}
            key={item.label}
            rel="noopener"
            target="_blank"
          >
            <item.icon className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
