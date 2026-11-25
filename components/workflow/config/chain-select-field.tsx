"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { sortChainsByName } from "@/lib/chains/sort-chains";
import type { ActionConfigFieldBase } from "@/plugins/registry";

export type Chain = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  isTestnet: boolean;
  isEnabled: boolean;
  usePrivateMempoolRpc: boolean;
};

type ChainSelectFieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /**
   * Filter chains by type. A single type ("evm") or several (["evm", "solana"]).
   * If not specified, all chain types are shown.
   */
  chainTypeFilter?: string | string[];
  /** Called with the chosen chain right after `onChange`, in the same tick. */
  onChainChosen?: (chain: Chain) => void;
  /**
   * Restrict to specific chain IDs (e.g., ["1", "8453"]).
   * Used by protocol actions to show only chains where the contract is deployed.
   */
  allowedChainIds?: string[];
};

export function ChainSelectField({
  field,
  value,
  onChange,
  disabled,
  chainTypeFilter,
  onChainChosen,
  allowedChainIds,
}: ChainSelectFieldProps) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Collapse the (string | string[]) filter into a stable primitive so an
  // inline array (e.g. ["evm", "solana"]) does not retrigger the fetch effect
  // every render via a changing array identity.
  const chainTypeKey = Array.isArray(chainTypeFilter)
    ? chainTypeFilter.join(",")
    : (chainTypeFilter ?? "");

  useEffect(() => {
    async function fetchChains() {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetch("/api/chains");
        if (!response.ok) {
          throw new Error("Failed to fetch chains");
        }

        const data = (await response.json()) as Chain[];

        const allowedTypes = chainTypeKey ? chainTypeKey.split(",") : null;
        let filteredChains = allowedTypes
          ? data.filter((chain) => allowedTypes.includes(chain.chainType))
          : data;

        if (allowedChainIds && allowedChainIds.length > 0) {
          const allowed = new Set(allowedChainIds);
          filteredChains = filteredChains.filter((chain) =>
            allowed.has(String(chain.chainId))
          );
        }

        setChains(filteredChains);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load chains");
      } finally {
        setIsLoading(false);
      }
    }

    fetchChains();
  }, [chainTypeKey, allowedChainIds]);

  if (isLoading) {
    return (
      <div className="flex h-10 items-center justify-center rounded-md border">
        <Spinner className="h-4 w-4" />
        <span className="ml-2 text-muted-foreground text-sm">
          Loading chains...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-destructive text-sm">
        {error}
      </div>
    );
  }

  if (chains.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        No chains available
      </div>
    );
  }

  // Grouped by testnet status, each group alphabetical. The analytics network
  // filter sorts through the same comparator so the two lists agree.
  const mainnets = sortChainsByName(
    chains.filter((chain) => !chain.isTestnet),
    (chain) => chain.name
  );
  const testnets = sortChainsByName(
    chains.filter((chain) => chain.isTestnet),
    (chain) => chain.name
  );

  function onSelectChain(chainId: string): void {
    onChange(chainId);
    const chain = chains.find((row) => String(row.chainId) === chainId);
    if (chain) {
      onChainChosen?.(chain);
    }
  }

  function renderChainItem(chain: Chain): React.ReactNode {
    return (
      <SelectItem key={chain.chainId} value={String(chain.chainId)}>
        <div className="flex items-center gap-2">
          <span>{chain.name}</span>
          <span className="text-muted-foreground text-xs">({chain.symbol})</span>
        </div>
      </SelectItem>
    );
  }

  return (
    <Select disabled={disabled} onValueChange={onSelectChain} value={value}>
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={field.placeholder || "Select a chain"} />
      </SelectTrigger>
      <SelectContent>
        {mainnets.length > 0 && (
          <>
            <div className="px-2 py-1.5 font-semibold text-muted-foreground text-xs">
              Mainnets
            </div>
            {mainnets.map(renderChainItem)}
          </>
        )}
        {testnets.length > 0 && (
          <>
            <div className="mt-1 px-2 py-1.5 font-semibold text-muted-foreground text-xs">
              Testnets
            </div>
            {testnets.map(renderChainItem)}
          </>
        )}
      </SelectContent>
    </Select>
  );
}

