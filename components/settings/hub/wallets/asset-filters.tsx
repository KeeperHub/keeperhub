"use client";

import { ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { AssetRow } from "./use-account-assets";

/** Remembers the chosen networks per account, so opening it again lands on them. */
export function useNetworkFilter(
  accountKey: string
): [string[], (next: string[]) => void] {
  const storageKey = `keeperhub-asset-networks:${accountKey}`;
  const [networks, setNetworks] = useState<string[]>([]);

  // Read after mount: the server cannot know the stored choice, and reading
  // during render would risk a hydration mismatch.
  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    setNetworks(stored ? (JSON.parse(stored) as string[]) : []);
  }, [storageKey]);

  const choose = useCallback(
    (next: string[]): void => {
      setNetworks(next);
      localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [storageKey]
  );

  return [networks, choose];
}

/** Every network the account touches, named, in the table's own order. */
export function networksOf(rows: AssetRow[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    seen.set(String(row.chainId), row.chainName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

function networkLabel(
  selected: string[],
  networks: { id: string; name: string }[]
): string {
  if (selected.length === 0) {
    return "All networks";
  }
  if (selected.length === 1) {
    return networks.find((n) => n.id === selected[0])?.name ?? "1 network";
  }
  return `${selected.length} networks`;
}

export function AssetFilters({
  query,
  onQueryChange,
  network,
  onNetworkChange,
  networks,
  hiddenCount,
  showZero,
  onToggleZero,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  /** Empty means every network. */
  network: string[];
  onNetworkChange: (next: string[]) => void;
  networks: { id: string; name: string }[];
  hiddenCount: number;
  showZero: boolean;
  onToggleZero: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
        <Input
          className="h-8 w-44 pl-8"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search assets"
          value={query}
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-8 w-44 justify-between"
            size="sm"
            variant="outline"
          >
            <span className="truncate">{networkLabel(network, networks)}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownMenuItem onSelect={() => onNetworkChange([])}>
            All networks
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {networks.map((n) => (
            <DropdownMenuCheckboxItem
              checked={network.includes(n.id)}
              key={n.id}
              onCheckedChange={(checked) =>
                onNetworkChange(
                  checked
                    ? [...network, n.id]
                    : network.filter((id) => id !== n.id)
                )
              }
              // Radix closes on select; a filter is usually set more than one
              // network at a time.
              onSelect={(event) => event.preventDefault()}
            >
              {n.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {hiddenCount > 0 && (
        <Button
          className="min-w-32"
          onClick={onToggleZero}
          size="sm"
          variant="ghost"
        >
          {showZero ? "Hide empty" : `Show ${hiddenCount} empty`}
        </Button>
      )}
    </div>
  );
}
