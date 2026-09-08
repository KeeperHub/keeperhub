"use client";

import { useCallback, useState } from "react";
import { ErrorCategory, logUserError } from "@/lib/logging";
import type {
  ChainBalance,
  ChainData,
  SupportedTokenBalance,
  TokenBalance,
} from "./types";

type ServerTokenBalance = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
  logoUrl?: string | null;
};

type ServerSupportedTokenBalance = {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
  logoUrl: string | null;
  explorerUrl: string | null;
};

type ServerChainBalance = {
  chainId: number;
  chainName: string;
  symbol: string;
  isTestnet: boolean;
  nativeBalance: string;
  nativeBalanceRaw: string;
  tokens: ServerTokenBalance[];
  supportedTokens: ServerSupportedTokenBalance[];
  error?: string;
};

type ServerBalancesResponse = {
  walletAddress: string;
  balances: ServerChainBalance[];
  error?: string;
};

type FetchBalancesOptions = {
  /**
   * When set, hits `/api/user/wallet/balances?safeId=X` so the server
   * returns the Safe's balances instead of the Turnkey EOA's. The caller
   * still supplies `address` so client-side display (explorer URLs etc.)
   * uses the Safe's address.
   */
  safeId?: string;
};

type UseWalletBalancesReturn = {
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  loading: boolean;
  fetchBalances: (
    address: string,
    chains: ChainData[],
    options?: FetchBalancesOptions
  ) => Promise<void>;
  refreshBalances: (
    address: string,
    chains: ChainData[],
    options?: FetchBalancesOptions
  ) => Promise<void>;
};

function buildExplorerAddressUrl(
  chain: ChainData | undefined,
  address: string
): string | null {
  if (!chain?.explorerUrl) {
    return null;
  }
  const path = chain.explorerAddressPath || "/address/{address}";
  return `${chain.explorerUrl}${path.replace("{address}", address)}`;
}

function buildLoadingChainBalances(
  chains: ChainData[],
  address: string
): ChainBalance[] {
  return chains.map((chain) => ({
    chainId: chain.chainId,
    name: chain.name,
    symbol: chain.symbol,
    balance: "0",
    loading: true,
    isTestnet: chain.isTestnet,
    explorerUrl: buildExplorerAddressUrl(chain, address),
  }));
}

/**
 * Hook for managing wallet balances. Fetches everything (native + tracked +
 * supported) from `/api/user/wallet/balances` so RPC calls happen server-side.
 * Provider URLs never leave the server.
 */
export function useWalletBalances(): UseWalletBalancesReturn {
  const [balances, setBalances] = useState<ChainBalance[]>([]);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [supportedTokenBalances, setSupportedTokenBalances] = useState<
    SupportedTokenBalance[]
  >([]);
  // True until the first fetch answers: with false, a caller sees an empty
  // list that has not been asked for yet and reads it as "nothing here".
  const [loading, setLoading] = useState(true);

  const fetchBalances = useCallback(
    async (
      address: string,
      chains: ChainData[],
      options?: FetchBalancesOptions
    ) => {
      if (chains.length === 0) {
        return;
      }

      setLoading(true);
      setBalances(buildLoadingChainBalances(chains, address));

      try {
        const url = options?.safeId
          ? `/api/user/wallet/balances?safeId=${encodeURIComponent(options.safeId)}`
          : "/api/user/wallet/balances";
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as ServerBalancesResponse;

        const chainsByid = new Map(chains.map((c) => [c.chainId, c]));

        const nextBalances: ChainBalance[] = data.balances.map((entry) => {
          const meta = chainsByid.get(entry.chainId);
          return {
            chainId: entry.chainId,
            name: entry.chainName,
            symbol: entry.symbol,
            balance: entry.nativeBalance,
            loading: false,
            isTestnet: entry.isTestnet,
            explorerUrl: buildExplorerAddressUrl(meta, address),
            error: entry.error,
          };
        });

        const nextTokens: TokenBalance[] = [];
        const nextSupported: SupportedTokenBalance[] = [];

        for (const entry of data.balances) {
          const meta = chainsByid.get(entry.chainId);
          // Defensive null-coalescing: some server paths (e.g. when a
          // chain's RPC errors) return the entry with `tokens` /
          // `supportedTokens` absent from the payload. `for...of`
          // throws on undefined, which silently fails the whole
          // setSupportedTokenBalances call and leaves every chain
          // stuck on the "Loading tokens..." empty-state fallback.
          for (const token of entry.tokens ?? []) {
            nextTokens.push({
              tokenId: `${entry.chainId}:${token.address}`,
              chainId: entry.chainId,
              tokenAddress: token.address,
              symbol: token.symbol,
              name: token.name,
              balance: token.balance,
              loading: false,
            });
          }
          for (const token of entry.supportedTokens ?? []) {
            nextSupported.push({
              chainId: entry.chainId,
              tokenAddress: token.tokenAddress,
              symbol: token.symbol,
              name: token.name,
              logoUrl: token.logoUrl,
              balance: token.balance,
              loading: false,
              explorerUrl:
                token.explorerUrl ?? buildExplorerAddressUrl(meta, address),
            });
          }
        }

        setBalances(nextBalances);
        setTokenBalances(nextTokens);
        setSupportedTokenBalances(nextSupported);
      } catch (error) {
        logUserError(
          ErrorCategory.EXTERNAL_SERVICE,
          "Failed to fetch wallet balances",
          error,
          { endpoint: "/api/user/wallet/balances" }
        );
        setBalances(
          chains.map((chain) => ({
            chainId: chain.chainId,
            name: chain.name,
            symbol: chain.symbol,
            balance: "0",
            loading: false,
            isTestnet: chain.isTestnet,
            explorerUrl: buildExplorerAddressUrl(chain, address),
            error: error instanceof Error ? error.message : "Failed to fetch",
          }))
        );
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const refreshBalances = useCallback(
    async (
      address: string,
      chains: ChainData[],
      options?: FetchBalancesOptions
    ) => {
      await fetchBalances(address, chains, options);
    },
    [fetchBalances]
  );

  return {
    balances,
    tokenBalances,
    supportedTokenBalances,
    loading,
    fetchBalances,
    refreshBalances,
  };
}
