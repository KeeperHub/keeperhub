"use client";

import { Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { type HubTabValue, isHubTabValue } from "@/app/hub/_tabs-shared";

// Tab-strip search input. URL `?q=` is the single source of truth so the
// active tab's RSC content (Protocols / Marketplace) can read it directly
// from `searchParams`, and the Workflows client island can sync its
// internal `searchQuery` state to it.

const PLACEHOLDERS: Record<HubTabValue, string> = {
  protocols: "Search protocols…",
  workflows: "Search workflows…",
  marketplace: "Search marketplace…",
};

const DEFAULT_TAB: HubTabValue = "protocols";

function readActiveTab(value: string | null): HubTabValue {
  if (value === null) {
    return DEFAULT_TAB;
  }
  const lower = value.trim().toLowerCase();
  return isHubTabValue(lower) ? lower : DEFAULT_TAB;
}

export function HubTabSearch(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = readActiveTab(searchParams.get("tab"));
  const placeholder = PLACEHOLDERS[activeTab];

  // Local mirror of `?q=` so typing feels instant. We push to the URL on
  // every keystroke through useTransition so the RSC re-render doesn't
  // block the input.
  const urlQuery = searchParams.get("q") ?? "";
  const [value, setValue] = useState(urlQuery);
  const [, startTransition] = useTransition();

  // Keep the input in sync when the URL changes externally (e.g. tab
  // switch that preserves `?q=`, or back/forward navigation).
  useEffect(() => {
    setValue(urlQuery);
  }, [urlQuery]);

  const writeUrl = (next: string): void => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "") {
      params.delete("q");
    } else {
      params.set("q", next);
    }
    // Reset pagination when the result set changes — the cursor payload was
    // encoded against the prior filtered set and would either skip rows or
    // return an empty page on the new query.
    params.delete("cursor");
    const qs = params.toString();
    startTransition(() => {
      // With `export const dynamic = 'force-dynamic'` on app/hub/page.tsx,
      // router.replace is sufficient — server components re-render with the
      // new searchParams and useSearchParams subscriptions in client
      // components fire too. Pairing with router.refresh() races: refresh
      // re-fetches the current URL, which on fast keystrokes is the
      // pre-replace URL, producing phantom /hub?tab=X (no q) requests that
      // overwrite the just-typed query in the RSC payload.
      router.replace(qs ? `/hub?${qs}` : "/hub", { scroll: false });
    });
  };

  const handleChange = (next: string): void => {
    setValue(next);
    writeUrl(next);
  };

  const handleClear = (): void => {
    setValue("");
    writeUrl("");
  };

  return (
    <div className="flex w-[280px] items-center gap-2 rounded-lg border border-border/60 bg-[var(--color-hub-icon-bg)] px-3.5 py-2 transition-colors focus-within:border-[var(--color-text-accent)]/40 focus-within:ring-1 focus-within:ring-[var(--color-text-accent)]/20 motion-reduce:transition-none">
      <Search
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
      <label className="sr-only" htmlFor="hub-tab-search">
        Search the active tab
      </label>
      <input
        // type="text" (not "search") avoids the WebKit/Chromium native
        // clear control that doubled up with our styled X. The custom
        // Clear button below is the single clear affordance; semantic
        // role still comes from the surrounding label + sr-only label.
        className="h-5 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        id="hub-tab-search"
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        type="text"
        value={value}
      />
      {value && (
        <button
          aria-label="Clear search"
          className="text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
          onClick={handleClear}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
