"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

export function SettingsSearch({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (next: string) => void;
}): React.ReactElement {
  return (
    <div className="relative px-2.5 pt-3">
      <Search className="-translate-y-1/2 absolute top-[calc(50%+6px)] left-4.5 size-3.5 text-muted-foreground" />
      <Input
        className="h-8 pr-7 pl-8 text-sm"
        data-testid="settings-search"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onQueryChange("")}
        placeholder="Search settings"
        value={query}
      />
      {query && (
        <button
          aria-label="Clear search"
          className="-translate-y-1/2 absolute top-[calc(50%+6px)] right-4 text-muted-foreground hover:text-foreground"
          onClick={() => onQueryChange("")}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
