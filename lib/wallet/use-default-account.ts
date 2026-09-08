"use client";

import { useCallback, useEffect, useState } from "react";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { accountSlug } from "@/lib/wallet/use-wallet-accounts";

export type PinnedAccount = {
  slug: string;
  address: string;
  isEvm: boolean;
};

function storageKey(organizationId: string | null): string | null {
  return organizationId ? `keeperhub-wallet-default:${organizationId}` : null;
}

function read(organizationId: string | null): PinnedAccount | null {
  const key = storageKey(organizationId);
  if (!key) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PinnedAccount) : null;
  } catch {
    return null;
  }
}

/**
 * The pinned account as the toolbar needs it: a plain read with no fetch
 * behind it, so the pill can show the chosen address before the menu that
 * loads the accounts has ever been opened. Null until the effect that reads
 * it runs, which keeps the server and client render agreeing.
 */
export function usePinnedAccount(
  organizationId: string | null
): PinnedAccount | null {
  const [pinned, setPinned] = useState<PinnedAccount | null>(null);

  useEffect(() => {
    setPinned(read(organizationId));
    const onPinned = (): void => setPinned(read(organizationId));
    window.addEventListener("keeperhub:wallet-pinned", onPinned);
    return () =>
      window.removeEventListener("keeperhub:wallet-pinned", onPinned);
  }, [organizationId]);

  return pinned;
}

/**
 * Which account the toolbar shows without being asked.
 *
 * An organization signs with more than one account, and which one a person
 * thinks of as "their" address is a preference, not a fact about the data.
 * It is remembered per organization, in this browser; the EVM signer stands
 * in until someone chooses otherwise.
 */
export function useDefaultAccount(
  organizationId: string | null,
  accounts: WalletAccountKind[]
): {
  account: WalletAccountKind | null;
  setDefault: (account: WalletAccountKind) => void;
  isDefault: (account: WalletAccountKind) => boolean;
} {
  const key = storageKey(organizationId);
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    setSlug(read(organizationId)?.slug ?? null);
  }, [organizationId]);

  const setDefault = useCallback(
    (account: WalletAccountKind): void => {
      const next: PinnedAccount = {
        address: account.address,
        isEvm: account.kind === "safe" || account.family === "evm",
        slug: accountSlug(account),
      };
      setSlug(next.slug);
      if (key) {
        window.localStorage.setItem(key, JSON.stringify(next));
        // The pill lives in a different tree; tell it directly.
        window.dispatchEvent(new Event("keeperhub:wallet-pinned"));
      }
    },
    [key]
  );

  // A remembered Safe can be gone by the next visit, so the stored choice is
  // a hint to look up rather than an account in its own right.
  const chosen = slug
    ? (accounts.find((a) => accountSlug(a) === slug) ?? null)
    : null;
  const account =
    chosen ?? accounts.find((a) => a.kind === "turnkey") ?? accounts[0] ?? null;

  return {
    account,
    isDefault: (candidate) =>
      account !== null && accountSlug(candidate) === accountSlug(account),
    setDefault,
  };
}
