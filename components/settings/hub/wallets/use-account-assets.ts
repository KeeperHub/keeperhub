"use client";

import { useMemo } from "react";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import {
  isTempoChain,
  nativeMirrorsSupportedToken,
} from "@/lib/wallet/build-withdrawable-assets";
import type { ChainData } from "@/lib/wallet/types";
import type { AccountDetailState } from "@/lib/wallet/use-account-detail";

export type AssetRow = {
  key: string;
  chainId: number;
  chainName: string;
  isTestnet: boolean;
  symbol: string;
  name: string;
  balance: string;
  tokenAddress?: string;
  kind: "native" | "token";
  explorerUrl: string | null;
};

function positive(raw: string): boolean {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0;
}

type AccountAssetsResult = {
  rows: AssetRow[];
  funded: AssetRow[];
  /** Every row the account has, whatever the table is filtered to. */
  all: AssetRow[];
  hiddenCount: number;
};

function computeAccountAssets(
  account: WalletAccountKind,
  detail: AccountDetailState,
  chains: ChainData[],
  showZero: boolean
): AccountAssetsResult {
  const scoped =
    account.kind === "safe"
      ? detail.balances.filter((b) => b.chainId === account.chainId)
      : detail.balances;
  const chainName = (id: number): string =>
    chains.find((c) => c.chainId === id)?.name ?? `Chain ${id}`;

  const rows: AssetRow[] = [];

  for (const balance of scoped) {
    // Tempo hides its native row unconditionally (no native gas token). Arc
    // hides its native row only once a funded supported-token row already
    // represents the same balance -- otherwise a partial token-seed
    // failure would make the balance both invisible and unwithdrawable.
    // Shares the predicate with the withdraw path and the wallet digest.
    if (
      isTempoChain(balance.chainId) ||
      nativeMirrorsSupportedToken(
        balance.chainId,
        detail.supportedTokenBalances
      )
    ) {
      continue;
    }
    rows.push({
      balance: balance.balance,
      chainId: balance.chainId,
      chainName: balance.name || chainName(balance.chainId),
      explorerUrl: balance.explorerUrl,
      isTestnet: balance.isTestnet,
      key: `native-${balance.chainId}`,
      kind: "native",
      name: balance.symbol,
      symbol: balance.symbol,
    });
  }

  const chainIds = new Set(scoped.map((b) => b.chainId));
  const testnetById = new Map(scoped.map((b) => [b.chainId, b.isTestnet]));

  for (const token of detail.supportedTokenBalances) {
    if (!chainIds.has(token.chainId) || token.available === false) {
      continue;
    }
    rows.push({
      balance: token.balance,
      chainId: token.chainId,
      chainName: chainName(token.chainId),
      explorerUrl: token.explorerUrl ?? null,
      isTestnet: testnetById.get(token.chainId) ?? false,
      key: `supported-${token.chainId}-${token.tokenAddress}`,
      kind: "token",
      name: token.name,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
    });
  }

  for (const token of detail.tokenBalances) {
    if (!chainIds.has(token.chainId)) {
      continue;
    }
    rows.push({
      balance: token.balance,
      chainId: token.chainId,
      chainName: chainName(token.chainId),
      explorerUrl: null,
      isTestnet: testnetById.get(token.chainId) ?? false,
      key: `tracked-${token.tokenId}`,
      kind: "token",
      name: token.name,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
    });
  }

  const funded = rows.filter((r) => positive(r.balance));
  const visible = showZero ? rows : funded;

  visible.sort(
    (a, b) =>
      Number(a.isTestnet) - Number(b.isTestnet) ||
      a.chainName.localeCompare(b.chainName) ||
      Number(b.kind === "native") - Number(a.kind === "native") ||
      a.symbol.localeCompare(b.symbol)
  );

  funded.sort(
    (a, b) =>
      Number(a.isTestnet) - Number(b.isTestnet) ||
      a.chainName.localeCompare(b.chainName)
  );

  return {
    all: rows,
    funded,
    hiddenCount: rows.length - funded.length,
    rows: visible,
  };
}

/**
 * Flattens the per-chain balance feeds into one sortable asset list so the
 * account page can render a table instead of a nested chain accordion.
 */
export function useAccountAssets(
  account: WalletAccountKind,
  detail: AccountDetailState,
  chains: ChainData[],
  showZero: boolean
): AccountAssetsResult {
  return useMemo(
    () => computeAccountAssets(account, detail, chains, showZero),
    [account, detail, chains, showZero]
  );
}

export { computeAccountAssets as __computeAccountAssetsForTesting };
