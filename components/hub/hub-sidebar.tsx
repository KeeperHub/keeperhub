"use client";

import { useSearchParams } from "next/navigation";
import { FilterSidebar } from "@/components/hub/filter-sidebar";
import type { PublicTag } from "@/lib/api-client";

export type SortValue = "most-used" | "featured" | "top-rated" | "name";

type HubSidebarProps = {
  publicTags: PublicTag[];
  sortBy: SortValue;
  onSortChange: (next: SortValue) => void;
  /**
   * Slug of the currently-active tag filter (driven by ?tag= query param).
   * Null when no tag filter is active.
   */
  activeTagSlug: string | null;
};

const SORT_OPTIONS: ReadonlyArray<{ value: SortValue; label: string }> = [
  { value: "top-rated", label: "Top rated" },
  { value: "most-used", label: "Most used" },
  { value: "featured", label: "Featured" },
  { value: "name", label: "Name" },
] as const;

function buildHref(
  currentParams: ReturnType<typeof useSearchParams>,
  tagSlug: string | null
): string {
  // Sidebar is mounted only inside the Workflows tab — the tabbed-hub URL
  // contract requires `tab=workflows` on every link out of the sidebar so
  // /hub doesn't bounce back to the default Protocols tab. Preserve any
  // unrelated query params the user is carrying (e.g. ?q=).
  const next = new URLSearchParams(currentParams.toString());
  next.set("tab", "workflows");
  if (tagSlug === null) {
    next.delete("tag");
  } else {
    next.set("tag", tagSlug);
  }
  return `/hub?${next.toString()}`;
}

export function HubSidebar({
  publicTags,
  sortBy,
  onSortChange,
  activeTagSlug,
}: HubSidebarProps): React.ReactElement {
  const searchParams = useSearchParams();

  return (
    <FilterSidebar
      activeSort={sortBy}
      activeTagSlug={activeTagSlug}
      ariaLabel="Hub filters"
      buildTagHref={(tagSlug) => buildHref(searchParams, tagSlug)}
      onSortChange={onSortChange}
      sortAriaLabel="Sort templates by"
      sortOptions={SORT_OPTIONS}
      tags={publicTags}
    />
  );
}
