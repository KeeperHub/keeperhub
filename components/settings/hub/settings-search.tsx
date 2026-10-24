"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SettingsSearch({
  query,
  onQueryChange,
  variant = "rail",
}: {
  query: string;
  onQueryChange: (next: string) => void;
  /** "menu" is the phone's settings menu: a full-width, tap-sized field. */
  variant?: "rail" | "menu";
}): React.ReactElement {
  const menu = variant === "menu";
  return (
    <div className={cn("relative", !menu && "px-2.5 pt-3")}>
      <Search
        className={cn(
          "-translate-y-1/2 absolute text-muted-foreground",
          menu
            ? "top-1/2 left-3 size-4"
            : "top-[calc(50%+6px)] left-4.5 size-3.5"
        )}
      />
      <Input
        aria-label={menu ? "Search settings" : undefined}
        className={cn(menu ? "h-11 pr-10 pl-9" : "h-8 pr-7 pl-8 text-sm")}
        data-testid={menu ? "settings-menu-search" : "settings-search"}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onQueryChange("")}
        placeholder="Search settings"
        value={query}
      />
      {query && (
        <button
          aria-label="Clear search"
          className={cn(
            "-translate-y-1/2 absolute text-muted-foreground hover:text-foreground",
            menu
              ? "top-1/2 right-0 flex size-11 items-center justify-center"
              : "top-[calc(50%+6px)] right-4"
          )}
          onClick={() => onQueryChange("")}
          type="button"
        >
          <X className={menu ? "size-4" : "size-3.5"} />
        </button>
      )}
    </div>
  );
}
