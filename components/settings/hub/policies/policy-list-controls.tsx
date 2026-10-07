"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Search across the policy list.
 *
 * The server does the matching, so this reports how many policies the query
 * found rather than how many of a loaded page survived a filter. Without it the
 * only way to find a rule was to guess which policy named the thing you cared
 * about.
 */
export function PolicySearch({
  value,
  onChange,
  matched,
  searching,
}: {
  value: string;
  onChange: (next: string) => void;
  /** How many policies the current query matched, from the server. */
  matched: number;
  /** True once a query is in effect, so the count reads as a result. */
  searching: boolean;
}): React.ReactElement {
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground"
        />
        <Input
          aria-label="Search policies"
          className="pl-8"
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search by name, capability, resource, or condition"
          value={value}
        />
      </div>
      {searching && (
        <p className="text-muted-foreground text-xs">
          {matched === 1 ? "1 policy matches" : `${matched} policies match`}
        </p>
      )}
    </div>
  );
}
