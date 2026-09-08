"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  type WithdrawableAsset,
  WithdrawModal,
} from "@/components/overlays/withdraw-modal";
import { authClient, useSession } from "@/lib/auth-client";
import {
  readCachedResource,
  writeCachedResource,
} from "@/lib/hooks/use-cached-resource";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { useInvalidateWalletInfo } from "@/lib/wallet/use-wallet-info";
import {
  addTrackedToken,
  createWallet,
  fetchChains,
  fetchDeployedSafes,
  fetchSupportedTokens,
  fetchTrackedTokens,
  fetchWallet,
  removeTrackedToken,
  type SafeRow as SafeRowType,
} from "@/lib/wallet/wallet-api";

export type SafeRow = SafeRowType;

export type OrgWalletState = {
  walletLoading: boolean;
  /** Safes arrive after the wallet, so a Safe is not missing until this. */
  safesLoaded: boolean;
  walletData: WalletData | null;
  chains: ChainData[];
  solanaIsTestnet: boolean;
  tokens: TokenData[];
  supportedTokens: SupportedToken[];
  safes: SafeRow[];
  setSafes: React.Dispatch<React.SetStateAction<SafeRow[]>>;
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  isLoadingBalances: boolean;
  loadWallet: () => Promise<void>;
  fetchSafes: () => Promise<SafeRow[]>;
  handleAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  handleRemoveToken: (tokenId: string, symbol: string) => Promise<void>;
  handleCreateWallet: (email: string) => Promise<void>;
  buildAssets: () => WithdrawableAsset[];
  handleWithdraw: (chainId: number, tokenAddress?: string) => void;
};

type OrgWalletSnapshot = {
  walletData: WalletData;
  chains: ChainData[];
  solanaIsTestnet: boolean;
  tokens: TokenData[];
  supportedTokens: SupportedToken[];
  safes: SafeRow[];
};

function findAssetIndex(
  assets: WithdrawableAsset[],
  chainId: number,
  tokenAddress?: string
): number {
  const idx = tokenAddress
    ? assets.findIndex(
        (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
      )
    : assets.findIndex((a) => a.chainId === chainId && a.type === "native");
  return idx >= 0 ? idx : 0;
}

/**
 * Shared data layer for every surface that manages the organization wallet.
 * The wallet overlay and the settings hub wallets page both mount this so the
 * fetch shape, the token mutations and the withdraw entry point stay in one
 * place.
 */
export function useOrgWallet(): OrgWalletState {
  const { push } = useOverlay();
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const invalidateWalletInfo = useInvalidateWalletInfo();

  // What the organization's wallet looked like last time. Leaving an account
  // and coming back re-runs this hook, and without a starting point every
  // visit paid for the whole load again before it could draw anything.
  const cacheKey = activeOrg?.id ? `org-wallet:${activeOrg.id}` : null;
  const cached = readCachedResource<OrgWalletSnapshot>(cacheKey);

  const [walletLoading, setWalletLoading] = useState(!cached);
  const [walletData, setWalletData] = useState<WalletData | null>(
    cached?.walletData ?? null
  );
  const [chains, setChains] = useState<ChainData[]>(cached?.chains ?? []);
  const [solanaIsTestnet, setSolanaIsTestnet] = useState(
    cached?.solanaIsTestnet ?? false
  );
  const [tokens, setTokens] = useState<TokenData[]>(cached?.tokens ?? []);
  const [supportedTokens, setSupportedTokens] = useState<SupportedToken[]>(
    cached?.supportedTokens ?? []
  );
  const [safes, setSafes] = useState<SafeRow[]>(cached?.safes ?? []);
  const [safesLoaded, setSafesLoaded] = useState(Boolean(cached));

  const {
    balances,
    tokenBalances,
    supportedTokenBalances,
    loading: isLoadingBalances,
    fetchBalances,
  } = useWalletBalances();

  const refreshSafes = useCallback(async (): Promise<SafeRow[]> => {
    try {
      const rows = await fetchDeployedSafes();
      setSafes(rows);
      return rows;
    } finally {
      setSafesLoaded(true);
    }
  }, []);

  const loadWallet = useCallback(async (): Promise<void> => {
    setWalletLoading(true);
    try {
      const data = await fetchWallet();
      setWalletData(data);
      setWalletLoading(false);
      if (!data.hasWallet) {
        setSafesLoaded(true);
        return;
      }

      const [chainResult, trackedTokens, supported, safeRows] =
        await Promise.all([
          fetchChains(),
          fetchTrackedTokens(),
          fetchSupportedTokens(),
          refreshSafes(),
        ]);
      setChains(chainResult.evmChains);
      setSolanaIsTestnet(chainResult.solanaIsTestnet);
      setTokens(trackedTokens);
      setSupportedTokens(supported);
      writeCachedResource(cacheKey, {
        chains: chainResult.evmChains,
        safes: safeRows,
        solanaIsTestnet: chainResult.solanaIsTestnet,
        supportedTokens: supported,
        tokens: trackedTokens,
        walletData: data,
      });

      if (data.walletAddress && chainResult.evmChains.length > 0) {
        fetchBalances(data.walletAddress, chainResult.evmChains);
      }
    } catch (error) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "Failed to load wallet",
        error,
        { component: "useOrgWallet" }
      );
      setWalletData({ hasWallet: false });
      setWalletLoading(false);
    }
  }, [refreshSafes, fetchBalances, cacheKey]);

  const handleAddToken = useCallback(
    async (chainId: number, tokenAddress: string): Promise<void> => {
      const symbol = await addTrackedToken(chainId, tokenAddress);
      toast.success(`Added ${symbol} to tracked tokens`);
      await loadWallet();
    },
    [loadWallet]
  );

  const handleRemoveToken = useCallback(
    async (tokenId: string, symbol: string): Promise<void> => {
      try {
        await removeTrackedToken(tokenId);
        toast.success(`Removed ${symbol} from tracked tokens`);
        await loadWallet();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove token"
        );
      }
    },
    [loadWallet]
  );

  const handleCreateWallet = useCallback(
    async (email: string): Promise<void> => {
      await createWallet(email);
      toast.success("Wallet created successfully!");
      await loadWallet();
      invalidateWalletInfo();
    },
    [loadWallet, invalidateWalletInfo]
  );

  const buildAssets = useCallback(
    (): WithdrawableAsset[] =>
      buildWithdrawableAssets({
        balances,
        chains,
        supportedTokenBalances,
        supportedTokens,
        tokenBalances,
        tokens,
      }),
    [
      balances,
      chains,
      supportedTokenBalances,
      supportedTokens,
      tokenBalances,
      tokens,
    ]
  );

  const handleWithdraw = useCallback(
    (chainId: number, tokenAddress?: string): void => {
      if (!walletData?.walletAddress) {
        return;
      }
      const assets = buildAssets();
      if (assets.length === 0) {
        toast.error("No assets available for withdrawal");
        return;
      }
      push(WithdrawModal, {
        assets,
        walletAddress: walletData.walletAddress,
        initialAssetIndex: findAssetIndex(assets, chainId, tokenAddress),
      });
    },
    [walletData?.walletAddress, buildAssets, push]
  );

  const sessionUserId = session?.user?.id;
  // The wallet, its Safes and every balance are organization-scoped, so the
  // active org is a fetch key just like the signed-in user. Without it,
  // switching organization leaves the previous org's accounts on screen.
  const activeOrgId = activeOrg?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionUserId and activeOrgId are refetch triggers
  useEffect(() => {
    loadWallet();
  }, [loadWallet, sessionUserId, activeOrgId]);

  return {
    balances,
    buildAssets,
    chains,
    fetchSafes: refreshSafes,
    handleAddToken,
    handleCreateWallet,
    handleRemoveToken,
    handleWithdraw,
    isLoadingBalances,
    loadWallet,
    safes,
    setSafes,
    solanaIsTestnet,
    supportedTokenBalances,
    supportedTokens,
    tokenBalances,
    tokens,
    walletData,
    safesLoaded,
    walletLoading,
  };
}
