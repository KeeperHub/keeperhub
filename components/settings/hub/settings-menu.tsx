"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BELOW_MD_QUERY } from "@/hooks/use-mobile";
import { useExitPath } from "./hooks/use-exit-path";
import { MENU_CARD, MENU_ROW, SettingsNavList } from "./settings-nav-list";
import { SettingsNavMatches } from "./settings-nav-matches";
import { SETTINGS_LINKS } from "./settings-rail";
import { SettingsSearch } from "./settings-search";

const FIRST_SECTION = "/settings/account";

/**
 * The phone's settings menu (SETTINGS_MENU_PATH): the rail, full width, with
 * each section leading back to it. Below md the rail is hidden (see
 * SettingsShell), so CSS shows this from the first paint; a wider window has
 * the rail beside every section and goes on to the first one.
 */
export function SettingsMenu(): React.ReactElement {
  const router = useRouter();
  const exitPath = useExitPath();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  useEffect(() => {
    // Asked again when the answer changes, e.g. a phone turned to a landscape
    // tablet width, where the rail is back.
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

  return (
    <div className="flex flex-col gap-5 md:hidden" data-testid="settings-menu">
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
      <div className={MENU_CARD}>
        {SETTINGS_LINKS.map((item) => (
          <a
            className={MENU_ROW}
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
