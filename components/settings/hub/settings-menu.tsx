"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BELOW_MD_QUERY,
  mediaQueryMatches,
  useIsMobile,
} from "@/hooks/use-mobile";
import { useExitPath } from "./hooks/use-exit-path";
import { SettingsNavList } from "./settings-nav-list";
import { SettingsNavMatches } from "./settings-nav-matches";
import { SettingsLinks } from "./settings-rail";
import { SettingsSearch } from "./settings-search";

const FIRST_SECTION = "/settings/account";

/**
 * The phone's settings menu, the /settings index: the rail, full width, with
 * each section leading back to it. Below md the rail is hidden (see
 * SettingsShell), so CSS shows this from the first paint; a wider window has
 * the rail beside every section and goes on to the first one.
 */
export function SettingsMenu(): React.ReactElement {
  const router = useRouter();
  const phone = useIsMobile();
  const exitPath = useExitPath();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  // `phone` is false while the page hydrates, so the width is read from the
  // shared list itself; `phone` only re-runs this when the breakpoint changes,
  // e.g. a phone turned to a landscape tablet width.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phone is a re-run trigger, not a value this reads
  useEffect(() => {
    if (!mediaQueryMatches(BELOW_MD_QUERY)) {
      router.replace(FIRST_SECTION);
    }
  }, [phone, router]);

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
      <SettingsLinks variant="menu" />
    </div>
  );
}
