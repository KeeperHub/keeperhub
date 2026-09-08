"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { useCachedResource } from "@/lib/hooks/use-cached-resource";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { SPONSORSHIP_CHAINS } from "@/lib/web3/sponsorship-chains-meta";

export type ChainRow = {
  chainId: number;
  name: string;
  symbol: string;
};

// `chains.symbol` is the chain's own ticker, which is not always what pays for
// gas there (Base's is "BASE", its gas is ETH), so the sponsorship table wins
// for the chains it covers and the registry answers for the rest.
const SPONSORED_BY_ID = new Map(
  SPONSORSHIP_CHAINS.map((chain) => [String(chain.chainId), chain])
);

export type ChainDisplay = {
  /** Chain name for a numeric chain id, falling back to the id itself. */
  name: (network: string) => string;
  /** Native gas-token ticker, empty when no source names one. */
  gasSymbol: (network: string | null) => string;
};

// A step records the chain it ran on as a chain id, but the older plugins
// record a slug ("tempo-testnet"), so both have to land on the same key.
function canonicalId(byId: Map<string, ChainRow>, network: string): string {
  if (byId.has(network) || SPONSORED_BY_ID.has(network)) {
    return network;
  }
  try {
    return String(getChainIdFromNetwork(network));
  } catch {
    return network;
  }
}

export function createChainDisplay(rows: ChainRow[] | undefined): ChainDisplay {
  const byId = new Map(
    (rows ?? []).map((row): [string, ChainRow] => [String(row.chainId), row])
  );
  return {
    name: (network: string): string => {
      const id = canonicalId(byId, network);
      return byId.get(id)?.name ?? SPONSORED_BY_ID.get(id)?.name ?? network;
    },
    gasSymbol: (network: string | null): string => {
      if (!network) {
        return "";
      }
      const id = canonicalId(byId, network);
      return SPONSORED_BY_ID.get(id)?.symbol ?? byId.get(id)?.symbol ?? "";
    },
  };
}

/** What the chains the platform sponsors are called, before the fetch lands. */
export const FALLBACK_CHAIN_DISPLAY: ChainDisplay = createChainDisplay([]);

const ChainDisplayContext = createContext<ChainDisplay>(FALLBACK_CHAIN_DISPLAY);

async function fetchChainRows(): Promise<ChainRow[]> {
  // Disabled chains included: a past run still names the chain it ran on.
  const response = await fetch("/api/chains?includeDisabled=true");
  if (!response.ok) {
    return [];
  }
  return (await response.json()) as ChainRow[];
}

export function ChainDisplayProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const { data } = useCachedResource<ChainRow[]>(
    "chain-display",
    fetchChainRows
  );
  const value = useMemo(() => createChainDisplay(data), [data]);
  return (
    <ChainDisplayContext.Provider value={value}>
      {children}
    </ChainDisplayContext.Provider>
  );
}

export function useChainDisplay(): ChainDisplay {
  return useContext(ChainDisplayContext);
}
