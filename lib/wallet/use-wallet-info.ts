"use client";

import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { walletRefreshAtom } from "@/lib/atoms/organization";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { useOrgWalletSummary } from "@/lib/hooks/use-org-data";

export type WalletInfoState = {
  hasWallet: boolean;
  walletAddress: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
};

/**
 * Call from components that mutate wallet state (create, switch active, etc.)
 * to force every subscribed useWalletInfo consumer to refetch.
 */
export function useInvalidateWalletInfo(): () => void {
  const setCounter = useSetAtom(walletRefreshAtom);
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
/**
 * Whether the active organization has a wallet, and its primary address.
 * Reads the shared store, so mounting this in several places is one request.
 */
export function useWalletInfo(): WalletInfoState {
  const { data: session } = useSession();
  const summary = useOrgWalletSummary();

  const email = session?.user?.email;
  // Wallet (SIWE) accounts have a synthetic email that is never verified; they
  // authenticate by signature, so they are authed without the verified-email
  // requirement (which stays in place for email / OAuth accounts).
  const isAuthed =
    !!session?.user?.id &&
    !!email &&
    !email.startsWith("temp-") &&
    (session?.user?.emailVerified === true || isWalletEmail(email));

  if (!isAuthed) {
    return {
      hasWallet: false,
      isLoading: false,
      refresh: summary.refetch,
      walletAddress: null,
    };
  }
  return {
    hasWallet: summary.hasWallet,
    isLoading: summary.isLoading,
    refresh: summary.refetch,
    walletAddress: summary.walletAddress,
  };
}
