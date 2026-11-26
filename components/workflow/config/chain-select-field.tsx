"use client";

import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { EditorChangeNotice } from "@/components/workflow/config/send-mode-field";
import { sortChainsByName } from "@/lib/chains/sort-chains";
import { useSendModeChains } from "@/lib/hooks/use-send-mode-chains";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type Chain = {
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
  // One shared /api/chains load for every network field and Send as reader.
  const { chains: rows, failed, retry } = useSendModeChains();

  // Collapse the (string | string[]) filter into a stable primitive so an
  // inline array (e.g. ["evm", "solana"]) does not recompute every render.
  const chainTypeKey = Array.isArray(chainTypeFilter)
    ? chainTypeFilter.join(",")
    : (chainTypeFilter ?? "");

  const chains = useMemo(() => {
    // The store holds the raw /api/chains rows, which carry every Chain field.
    const data = (rows ?? []) as readonly Chain[];
    const allowedTypes = chainTypeKey ? chainTypeKey.split(",") : null;
    const allowed =
      allowedChainIds && allowedChainIds.length > 0
        ? new Set(allowedChainIds)
        : null;
    return data.filter(
      (chain) =>
        (!allowedTypes || allowedTypes.includes(chain.chainType)) &&
        (!allowed || allowed.has(String(chain.chainId)))
    );
  }, [rows, chainTypeKey, allowedChainIds]);

  // Each state carries the field's id, so focus stays on the field across a Retry.
  if (failed) {
    // The same look as Send as's notice for this failure.
    return (
      <div id={field.key} role="status" tabIndex={-1}>
        <EditorChangeNotice
          action={{ label: "Retry", onClick: () => retry(field.key) }}
          testId="network-chains-error"
          text="The network list did not load."
          tone="warning"
        />
      </div>
    );
  }

  if (rows === undefined) {
    return (
      <div
        className="flex h-10 items-center justify-center rounded-md border"
        id={field.key}
        role="status"
        tabIndex={-1}
      >
        <Spinner aria-hidden="true" className="h-4 w-4" />
        <span className="ml-2 text-muted-foreground text-sm">
          Loading chains...
        </span>
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

