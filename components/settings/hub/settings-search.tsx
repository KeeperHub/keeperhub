"use client";

import { SearchInput } from "@/components/ui/search-input";

export function SettingsSearch({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (next: string) => void;
}): React.ReactElement {
  return (
    <div className="px-2.5 pt-3">
      <SearchInput
        aria-label="Search settings"
        data-testid="settings-search"
        onValueChange={onQueryChange}
        placeholder="Search settings"
        value={query}
      />
    </div>
  );
}
