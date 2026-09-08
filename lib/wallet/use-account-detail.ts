"use client";

import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { WithdrawModal } from "@/components/overlays/withdraw-modal";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainBalance,
  SupportedTokenBalance,
  TokenBalance,
} from "@/lib/wallet/types";
import type { OrgWalletState } from "@/lib/wallet/use-org-wallet";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";

export type AccountDetailState = {
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  isLoadingBalances: boolean;
  addToken: (chainId: number, tokenAddress: string) => Promise<void>;
  removeToken: (tokenId: string, symbol: string) => Promise<void>;
  withdraw: (chainId: number, tokenAddress?: string) => void;
};

function assetIndex(
  assets: { chainId: number; tokenAddress?: string; type: string }[],
  chainId: number,
  tokenAddress?: string
): number {
  const idx = tokenAddress
    ? assets.findIndex(
        (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
      )
    : assets.findIndex((a) => a.chainId === chainId && a.type === "native");
  return Math.max(0, idx);
}

/**
 * Resolves the balances and mutations for one wallet account. A Safe holds
 * its own funds at a different address from the org's Turnkey EOA, so it gets
 * a dedicated balance fetch and Safe-scoped token and withdraw calls; the
 * Turnkey account reuses whatever the org-level state already loaded.
 */
export function useAccountDetail(
  account: WalletAccountKind,
  state: OrgWalletState
): AccountDetailState {
  const { push } = useOverlay();
  const safe = useWalletBalances();
  const isSafe = account.kind === "safe";
  const safeId = isSafe ? account.safeId : null;
  const safeAddress = isSafe ? account.address : null;
  const safeChainId = isSafe ? account.chainId : null;
  const { chains, supportedTokens, tokens } = state;

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable fns from useWalletBalances; refetch only on account identity change
  useEffect(() => {
    if (!(safeId && safeAddress && safeChainId !== null)) {
      return;
    }
    const chain = chains.find((c) => c.chainId === safeChainId);
    if (!chain) {
      return;
    }
    safe.fetchBalances(safeAddress, [chain], { safeId }).catch(() => {
      // useWalletBalances logs and toasts on failure.
    });
  }, [safeId, safeAddress, safeChainId, chains]);

  const refreshSafe = useCallback(async (): Promise<void> => {
    if (!(safeId && safeAddress && safeChainId !== null)) {
      return;
    }
    const chain = chains.find((c) => c.chainId === safeChainId);
    if (chain) {
      await safe.refreshBalances(safeAddress, [chain], { safeId });
    }
  }, [safeId, safeAddress, safeChainId, chains, safe]);

  const addToken = useCallback(
    async (chainId: number, tokenAddress: string): Promise<void> => {
      if (account.kind !== "safe") {
        await state.handleAddToken(chainId, tokenAddress);
        return;
      }
      const res = await fetch("/api/user/wallet/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId, tokenAddress, safeId: account.safeId }),
      });
      const data = (await res.json()) as {
        token?: { symbol: string };
        error?: string;
      };
      if (!(res.ok && data.token)) {
        throw new Error(data.error ?? "Failed to add token");
      }
      toast.success(`Added ${data.token.symbol} to ${account.chainName}`);
      await refreshSafe();
    },
    [account, state, refreshSafe]
  );

  const removeToken = useCallback(
    async (tokenId: string, symbol: string): Promise<void> => {
      if (account.kind !== "safe") {
        await state.handleRemoveToken(tokenId, symbol);
        return;
      }
      try {
        const res = await fetch("/api/user/wallet/tokens", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error ?? "Failed to remove token");
        }
        toast.success(`Removed ${symbol} from ${account.chainName}`);
        await refreshSafe();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove token"
        );
      }
    },
    [account, state, refreshSafe]
  );

  const withdraw = useCallback(
    (chainId: number, tokenAddress?: string): void => {
      if (account.kind !== "safe") {
        state.handleWithdraw(chainId, tokenAddress);
        return;
      }
      const assets = buildWithdrawableAssets({
        balances: safe.balances,
        chains,
        supportedTokenBalances: safe.supportedTokenBalances,
        supportedTokens,
        tokenBalances: safe.tokenBalances,
        tokens,
      });
      if (assets.length === 0) {
        toast.error("No assets available for withdrawal");
        return;
      }
      push(WithdrawModal, {
        assets,
        initialAssetIndex: assetIndex(assets, chainId, tokenAddress),
        source: {
          kind: "safe" as const,
          safeId: account.safeId,
          safeAddress: account.address,
          chainName: account.chainName,
        },
        walletAddress: account.address,
      });
    },
    [account, state, push, safe, chains, supportedTokens, tokens]
  );

  return {
    addToken,
    balances: isSafe ? safe.balances : state.balances,
    isLoadingBalances: isSafe ? safe.loading : state.isLoadingBalances,
    removeToken,
    supportedTokenBalances: isSafe
      ? safe.supportedTokenBalances
      : state.supportedTokenBalances,
    tokenBalances: isSafe ? safe.tokenBalances : state.tokenBalances,
    withdraw,
  };
}
