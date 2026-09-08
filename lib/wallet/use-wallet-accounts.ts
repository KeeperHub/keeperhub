"use client";

import { useMemo } from "react";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import {
  getChainOrderIndex,
  getDisplayChainName,
} from "@/components/overlays/wallet/chain-utils";
import type { ChainData } from "@/lib/wallet/types";
import type { SafeRow } from "@/lib/wallet/use-org-wallet";

type WalletAccountsInput = {
  walletAddress?: string | null;
  solanaAddress?: string | null;
  solanaIsTestnet: boolean;
  safes: SafeRow[];
  chains: ChainData[];
};

export type WalletAccounts = {
  turnkey: WalletAccountKind | null;
  solana: WalletAccountKind | null;
  safes: WalletAccountKind[];
  all: WalletAccountKind[];
};

/** Stable URL segment for an account, used by the wallet detail route. */
export function accountSlug(account: WalletAccountKind): string {
  if (account.kind === "safe") {
    return account.safeId;
  }
  return account.family === "solana" ? "solana" : "evm";
}

export function accountTitle(account: WalletAccountKind): string {
  if (account.kind === "safe") {
    return `Safe · ${account.chainName}`;
  }
  // Named for the family the address belongs to. Which custody provider holds
  // the key is not something a person picks or acts on from here.
  return account.family === "solana" ? "Solana" : "EVM";
}

/**
 * The name a slug carries on its own. Both signer accounts are named by their
 * slug alone, so a heading does not have to wait for the wallet to load; a
 * Safe's name carries its network, which the slug does not hold.
 */
export function accountTitleForSlug(slug: string): string {
  if (slug === "evm" || slug === "solana") {
    return accountTitle({
      address: "",
      family: slug === "solana" ? "solana" : "evm",
      kind: "turnkey",
    } as WalletAccountKind);
  }
  return "Safe";
}

/** Derives the renderable account rows from the raw wallet payload. */
export function useWalletAccounts({
  walletAddress,
  solanaAddress,
  solanaIsTestnet,
  safes,
  chains,
}: WalletAccountsInput): WalletAccounts {
  return useMemo(() => {
    const turnkey: WalletAccountKind | null = walletAddress
      ? { kind: "turnkey", address: walletAddress, family: "evm" }
      : null;

    const solana: WalletAccountKind | null = solanaAddress
      ? {
          kind: "turnkey",
          address: solanaAddress,
          family: "solana",
          solanaIsTestnet,
        }
      : null;

    const safeAccounts: WalletAccountKind[] = safes
      .slice()
      .sort(
        (a, b) => getChainOrderIndex(a.chainId) - getChainOrderIndex(b.chainId)
      )
      .map((s) => {
        const chain = chains.find((c) => c.chainId === s.chainId);
        return {
          address: s.safeAddress,
          chainId: s.chainId,
          chainName: getDisplayChainName(chain?.name ?? `Chain ${s.chainId}`),
          isSigningActive: s.isSigningActive,
          kind: "safe" as const,
          safeId: s.id,
        };
      });

    return {
      all: [turnkey, solana, ...safeAccounts].filter(
        (a): a is WalletAccountKind => a !== null
      ),
      safes: safeAccounts,
      solana,
      turnkey,
    };
  }, [walletAddress, solanaAddress, solanaIsTestnet, safes, chains]);
}
