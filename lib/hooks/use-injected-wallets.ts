"use client";

import { useEffect, useState } from "react";
import type { DiscoveredWallet } from "@/lib/wallet/connect-types";

/**
 * Discovers injected browser wallets via EIP-6963. On mount we listen for
 * `eip6963:announceProvider` events and ask wallets to announce themselves
 * with `eip6963:requestProvider`. Unlike reading `window.ethereum`, this
 * cleanly surfaces every installed wallet (MetaMask, Brave, Rabby, Coinbase,
 * ...) without them colliding on a single global. Deduped by `rdns`.
 */
export function useInjectedWallets(): DiscoveredWallet[] {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);

  useEffect(() => {
    const onAnnounce = (event: Event): void => {
      const detail = (event as CustomEvent<DiscoveredWallet>).detail;
      if (!detail?.info?.rdns) {
        return;
      }
      setWallets((prev) => {
        if (prev.some((w) => w.info.rdns === detail.info.rdns)) {
          return prev;
        }
        return [...prev, detail];
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, []);

  return wallets;
}
