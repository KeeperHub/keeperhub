"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { FilterSidebar } from "@/components/hub/filter-sidebar";
import type { MarketplaceSort } from "@/lib/marketplace/leaderboard-query";

// Visible sort options. Mirrors the previous MarketplaceSortDropdown.
// Revenue-based sort is EXPLICITLY DEFERRED per MARKET-02 + MARKET-FUTURE-01
// (privacy review pending).
const SORT_OPTIONS: ReadonlyArray<{ value: MarketplaceSort; label: string }> = [
  { value: "popular", label: "Popular" },
  { value: "newest", label: "Newest" },
  { value: "top-calls", label: "Calls" },
  { value: "price", label: "Price" },
  { value: "owner", label: "Owner" },
] as const;

export type MarketplaceSidebarTag = {
  name: string;
  slug: string;
};

type Props = {
  active: MarketplaceSort;
  activeTagSlug: string | null;
  tags: MarketplaceSidebarTag[];
};

function buildTagHref(
  currentParams: ReturnType<typeof useSearchParams>,
  tagSlug: string | null
): string {
  // Mirror the marketplace sort writer: pin tab=marketplace, set/delete
  // tag, drop cursor (cursor was paged against the prior filter set).
  // Preserve unrelated params (q, sort).
  const next = new URLSearchParams(currentParams.toString());
  next.set("tab", "marketplace");
  if (tagSlug === null) {
    next.delete("tag");
  } else {
    next.set("tag", tagSlug);
  }
  next.delete("cursor");
  return `/hub?${next.toString()}`;
}

export function MarketplaceSidebar({
  active,
  activeTagSlug,
  tags,
}: Props): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const handleSelectSort = (value: MarketplaceSort): void => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "marketplace");
    params.set("sort", value);
    // Reset cursor when sort changes — page 2 of `popular` does not
    // apply to `newest` etc.
    params.delete("cursor");
    startTransition(() => {
      router.replace(`/hub?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <FilterSidebar
      activeSort={active}
      activeTagSlug={activeTagSlug}
      ariaLabel="Marketplace filters"
      buildTagHref={(tagSlug) => buildTagHref(searchParams, tagSlug)}
      onSortChange={handleSelectSort}
      sortAriaLabel="Sort marketplace by"
      sortOptions={SORT_OPTIONS}
      tags={tags}
    />
  );
}
