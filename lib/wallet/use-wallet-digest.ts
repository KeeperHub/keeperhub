"use client";

import { useCallback, useMemo } from "react";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import {
  type BillingSummary,
  billingSummaryCacheKey,
  fetchBillingSummary,
} from "@/lib/billing/summary";
import { useCachedResource } from "@/lib/hooks/use-cached-resource";
import {
  buildWithdrawableAssets,
  type WithdrawableAsset,
} from "@/lib/wallet/build-withdrawable-assets";
import {
  fetchSpendCap,
  type SpendCap,
  type SpendCapResponse,
  spendCapCacheKey,
  toSpendCaps,
} from "@/lib/wallet/spend-cap";
import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletAccounts } from "@/lib/wallet/use-wallet-accounts";
import {
  fetchChains,
  fetchDeployedSafes,
  fetchSupportedTokens,
  fetchTrackedTokens,
  fetchWallet,
  type SafeRow,
} from "@/lib/wallet/wallet-api";

// Stable identities: a fresh [] per render would bust every downstream memo.
const NO_CHAINS: ChainData[] = [];
const NO_SAFES: SafeRow[] = [];

/** One holding the signer has, flattened out of the per-chain balance feed. */
export type DigestAsset = {
  key: string;
  symbol: string;
  name: string;
  chainId: number;
  chainName: string;
  balance: string;
  isTestnet: boolean;
  kind: "native" | "token";
  tokenAddress?: string;
  /** Absent when nothing could price this asset. */
  usdValue: number | null;
};

export type WalletTotal = {
  usd: number;
  /** Holdings no price could be found for, so the total can say so. */
  unpriced: number;
};

export type WalletDigestState = {
  accounts: WalletAccountKind[];
  accountsLoading: boolean;
  /** Funded holdings only, most valuable first. */
  assets: DigestAsset[];
  balancesLoading: boolean;
  total: WalletTotal;
  fundedNetworks: number;
  billing: BillingSummary | null;
  caps: SpendCap[];
  /** What the withdraw flow needs, or an empty list while balances load. */
  sendableAssets: () => WithdrawableAsset[];
};

type AccountsPayload = {
  wallet: WalletData;
  chains: ChainData[];
  solanaIsTestnet: boolean;
  safes: SafeRow[];
  supportedTokens: SupportedToken[];
  trackedTokens: TokenData[];
};

type ServerToken = {
  address?: string;
  tokenAddress?: string;
  symbol: string;
  name: string;
  balance: string;
  logoUrl?: string | null;
  explorerUrl?: string | null;
};

type ServerChainBalance = {
  chainId: number;
  chainName: string;
  symbol: string;
  isTestnet: boolean;
  nativeBalance: string;
  tokens?: ServerToken[];
  supportedTokens?: ServerToken[];
};

type Balances = {
  raw: ServerChainBalance[];
  prices: Record<string, number>;
};

function priceKey(chainId: number, tokenAddress?: string): string {
  return `${chainId}:${(tokenAddress ?? "0x0000000000000000000000000000000000000000").toLowerCase()}`;
}

async function fetchAccounts(): Promise<AccountsPayload> {
  const [wallet, chains, safes, supportedTokens, trackedTokens] =
    await Promise.all([
      fetchWallet(),
      fetchChains(),
      fetchDeployedSafes(),
      fetchSupportedTokens(),
      fetchTrackedTokens(),
    ]);
  return {
    chains: chains.evmChains,
    safes,
    solanaIsTestnet: chains.solanaIsTestnet,
    supportedTokens,
    trackedTokens,
    wallet,
  };
}

function positive(raw: string): boolean {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Every funded holding, before prices are attached. */
function fundedAssets(
  balances: ServerChainBalance[]
): Omit<DigestAsset, "usdValue">[] {
  const assets: Omit<DigestAsset, "usdValue">[] = [];
  for (const chain of balances) {
    if (positive(chain.nativeBalance)) {
      assets.push({
        balance: chain.nativeBalance,
        chainId: chain.chainId,
        chainName: chain.chainName,
        isTestnet: chain.isTestnet,
        key: `native-${chain.chainId}`,
        kind: "native",
        name: chain.symbol,
        symbol: chain.symbol,
      });
    }
    for (const token of [
      ...(chain.supportedTokens ?? []),
      ...(chain.tokens ?? []),
    ]) {
      const address = token.tokenAddress ?? token.address;
      if (!(positive(token.balance) && address)) {
        continue;
      }
      assets.push({
        balance: token.balance,
        chainId: chain.chainId,
        chainName: chain.chainName,
        isTestnet: chain.isTestnet,
        key: `token-${chain.chainId}-${address}`,
        kind: "token",
        name: token.name,
        symbol: token.symbol,
        tokenAddress: address,
      });
    }
  }
  return assets;
}

async function fetchBalances(): Promise<Balances> {
  const res = await fetch("/api/user/wallet/balances");
  if (!res.ok) {
    return { prices: {}, raw: [] };
  }
  const data = (await res.json()) as { balances?: ServerChainBalance[] };
  const raw = data.balances ?? [];

  // Only what the wallet actually holds is worth pricing.
  const funded = fundedAssets(raw).filter((a) => !a.isTestnet);
  if (funded.length === 0) {
    return { prices: {}, raw };
  }
  const priced = await fetch("/api/user/wallet/prices", {
    body: JSON.stringify({
      assets: funded.map((a) => ({
        chainId: a.chainId,
        tokenAddress: a.tokenAddress,
      })),
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => null);
  if (!priced?.ok) {
    return { prices: {}, raw };
  }
  const body = (await priced.json()) as { prices?: Record<string, number> };
  return { prices: body.prices ?? {}, raw };
}

/** The three balance shapes the withdraw flow reads, out of one payload. */
function toBalanceFeeds(raw: ServerChainBalance[]): {
  balances: ChainBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  tokenBalances: TokenBalance[];
} {
  const balances: ChainBalance[] = raw.map((chain) => ({
    balance: chain.nativeBalance,
    chainId: chain.chainId,
    explorerUrl: null,
    isTestnet: chain.isTestnet,
    loading: false,
    name: chain.chainName,
    symbol: chain.symbol,
  }));
  const supportedTokenBalances: SupportedTokenBalance[] = [];
  const tokenBalances: TokenBalance[] = [];
  for (const chain of raw) {
    for (const token of chain.supportedTokens ?? []) {
      supportedTokenBalances.push({
        balance: token.balance,
        chainId: chain.chainId,
        explorerUrl: token.explorerUrl ?? null,
        loading: false,
        logoUrl: token.logoUrl ?? null,
        name: token.name,
        symbol: token.symbol,
        tokenAddress: token.tokenAddress ?? "",
      });
    }
    for (const token of chain.tokens ?? []) {
      tokenBalances.push({
        balance: token.balance,
        chainId: chain.chainId,
        loading: false,
        name: token.name,
        symbol: token.symbol,
        tokenAddress: token.address ?? "",
        tokenId: `${chain.chainId}:${token.address}`,
      });
    }
  }
  return { balances, supportedTokenBalances, tokenBalances };
}

/**
 * Everything the toolbar wallet menu shows, in one place.
 *
 * Mounted only while the menu is open, so a header that renders on every page
 * costs nothing until someone asks. Cache keys are the ones the settings hub
 * writes, so a visit to either surface warms the other.
 */
export function useWalletDigest(
  organizationId: string | null
): WalletDigestState {
  // The version rides in the key: the cache outlives a reload of the code, so
  // a payload that grew a field must miss rather than read the old shape back.
  const accountsKey = organizationId
    ? `wallet-accounts:v2:${organizationId}`
    : null;
  const balancesKey = organizationId
    ? `wallet-balances:v2:${organizationId}`
    : null;

  const accounts = useCachedResource<AccountsPayload>(
    accountsKey,
    fetchAccounts
  );
  const balances = useCachedResource<Balances>(balancesKey, fetchBalances);
  const billing = useCachedResource<BillingSummary | null>(
    billingSummaryCacheKey(organizationId),
    fetchBillingSummary
  );
  const caps = useCachedResource<SpendCapResponse | null>(
    spendCapCacheKey(organizationId),
    fetchSpendCap
  );

  const rows = useWalletAccounts({
    chains: accounts.data?.chains ?? NO_CHAINS,
    safes: accounts.data?.safes ?? NO_SAFES,
    solanaAddress: accounts.data?.wallet.solanaAddress,
    solanaIsTestnet: accounts.data?.solanaIsTestnet ?? false,
    walletAddress: accounts.data?.wallet.walletAddress,
  });

  const assets = useMemo<DigestAsset[]>(() => {
    const prices = balances.data?.prices ?? {};
    const priced = fundedAssets(balances.data?.raw ?? []).map((asset) => {
      const price = prices[priceKey(asset.chainId, asset.tokenAddress)];
      const amount = Number.parseFloat(asset.balance);
      return {
        ...asset,
        usdValue:
          price && Number.isFinite(amount) ? price * amount : (null as null),
      };
    });
    // Worth first, the way a wallet reads. Unpriced holdings keep a stable
    // place under them rather than being scattered by name.
    priced.sort(
      (a, b) =>
        Number(a.isTestnet) - Number(b.isTestnet) ||
        (b.usdValue ?? -1) - (a.usdValue ?? -1) ||
        a.chainName.localeCompare(b.chainName) ||
        Number(b.kind === "native") - Number(a.kind === "native") ||
        a.symbol.localeCompare(b.symbol)
    );
    return priced;
  }, [balances.data]);

  const total = useMemo<WalletTotal>(() => {
    let usd = 0;
    let unpriced = 0;
    for (const asset of assets) {
      if (asset.isTestnet) {
        continue;
      }
      if (asset.usdValue === null) {
        unpriced += 1;
      } else {
        usd += asset.usdValue;
      }
    }
    return { unpriced, usd };
  }, [assets]);

  const data = accounts.data;
  const raw = balances.data?.raw;
  const sendableAssets = useCallback((): WithdrawableAsset[] => {
    if (!(data && raw)) {
      return [];
    }
    const feeds = toBalanceFeeds(raw);
    // A partial payload must not take the toolbar down with it: this runs
    // from a click handler, where a throw unmounts the header.
    try {
      return buildWithdrawableAssets({
        balances: feeds.balances,
        chains: data.chains ?? NO_CHAINS,
        supportedTokenBalances: feeds.supportedTokenBalances,
        supportedTokens: data.supportedTokens ?? [],
        tokenBalances: feeds.tokenBalances,
        tokens: data.trackedTokens ?? [],
      });
    } catch {
      return [];
    }
  }, [data, raw]);

  return {
    accounts: rows.all,
    accountsLoading: accounts.loading,
    assets,
    balancesLoading: balances.loading,
    billing: billing.data ?? null,
    caps: toSpendCaps(caps.data ?? null),
    fundedNetworks: new Set(assets.map((a) => a.chainId)).size,
    sendableAssets,
    total,
  };
}
