"use client";

import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient, useSession } from "@/lib/auth-client";

export type WalletInfoState = {
  hasWallet: boolean;
  walletAddress: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
};

type WalletResponse = {
  hasWallet?: boolean;
  walletAddress?: string;
};

/**
 * Counter atom to let parts of the app (e.g. the wallet overlay after
 * switching the active wallet) invalidate any mounted useWalletInfo hooks.
 */
const walletInfoRefreshAtom = atom(0);

/**
 * Call from components that mutate wallet state (create, switch active, etc.)
 * to force every subscribed useWalletInfo consumer to refetch.
 */
export function useInvalidateWalletInfo(): () => void {
  const setCounter = useSetAtom(walletInfoRefreshAtom);
  return useCallback(() => {
    setCounter((n) => n + 1);
  }, [setCounter]);
}

/**
 * Lightweight hook that tracks whether the active organization has a wallet
 * and exposes the primary address. Safe to mount in shared chrome (toolbar)
 * because it short-circuits for anonymous sessions. Refetches automatically
 * when the active org changes or useInvalidateWalletInfo is fired.
 */
export function useWalletInfo(): WalletInfoState {
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const _refreshCounter = useAtomValue(walletInfoRefreshAtom);
  const [hasWallet, setHasWallet] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const sessionUserId = session?.user?.id;
  const email = session?.user?.email;
  // Wallet (SIWE) accounts have a synthetic email that is never verified; they
  // authenticate by signature, so they are authed without the verified-email
  // requirement (which stays in place for email / OAuth accounts).
  const isAuthed =
    !!sessionUserId &&
    !!email &&
    !email.startsWith("temp-") &&
    (session?.user?.emailVerified === true || isWalletEmail(email));

  const _activeOrgId = activeOrg?.id ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!isAuthed) {
      setHasWallet(false);
      setWalletAddress(null);
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch("/api/user/wallet");
      if (!response.ok) {
        setHasWallet(false);
        setWalletAddress(null);
        return;
      }
      const data = (await response.json()) as WalletResponse;
      if (data.hasWallet && data.walletAddress) {
        setHasWallet(true);
        setWalletAddress(data.walletAddress);
      } else {
        setHasWallet(false);
        setWalletAddress(null);
      }
    } catch {
      setHasWallet(false);
      setWalletAddress(null);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthed]);

  // Refetch when auth state changes, when the active org switches, or when
  // useInvalidateWalletInfo bumps the counter (wallet create / switch active).
  useEffect(() => {
    refresh();
  }, [refresh]);

  return { hasWallet, walletAddress, isLoading, refresh };
}
