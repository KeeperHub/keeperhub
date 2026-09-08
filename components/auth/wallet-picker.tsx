"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { useInjectedWallets } from "@/lib/hooks/use-injected-wallets";
import type { DiscoveredWallet, WalletBrand } from "@/lib/wallet/connect-types";
import { loginWithWallet } from "@/lib/wallet/wallet-login";

const POPULAR_WALLETS: WalletBrand[] = [
  {
    rdns: "io.metamask",
    name: "MetaMask",
    installUrl: "https://metamask.io/download/",
    icon: "/wallets/metamask.svg",
  },
  {
    rdns: "io.rabby",
    name: "Rabby",
    installUrl: "https://rabby.io/",
    icon: "/wallets/rabby.png",
  },
  {
    rdns: "com.coinbase.wallet",
    name: "Coinbase Wallet",
    installUrl: "https://www.coinbase.com/wallet/downloads",
    icon: "/wallets/coinbase.png",
  },
];

// Icon tile for a wallet row. Detected wallets pass their official EIP-6963
// icon; install suggestions pass their bundled brand icon.
function WalletIcon({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): React.ReactElement {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md">
      <Image alt={alt} height={28} src={src} unoptimized width={28} />
    </span>
  );
}

/**
 * Shared wallet sign-in list: EIP-6963 discovered wallets plus install
 * suggestions for popular wallets that are not detected. Signs in via SIWE
 * (loginWithWallet) and refreshes the session, then calls onConnected. Used by
 * both the Connect modal and the welcome page's "Sign in with your wallet" view.
 */
export function WalletPicker({
  onConnected,
}: {
  onConnected?: () => void;
}): React.ReactElement {
  const { refetch } = useSession();
  const wallets = useInjectedWallets();
  // Hide an install suggestion once that wallet is actually detected.
  const installedRdns = new Set(wallets.map((w) => w.info.rdns));
  const installable = POPULAR_WALLETS.filter((w) => !installedRdns.has(w.rdns));
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectHint, setConnectHint] = useState(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHintTimer = (): void => {
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  };

  const handleConnect = async (wallet: DiscoveredWallet): Promise<void> => {
    setConnecting(wallet.info.rdns);
    setConnectHint(false);
    hintTimerRef.current = setTimeout(() => setConnectHint(true), 2000);
    const result = await loginWithWallet(wallet.provider);
    clearHintTimer();
    setConnecting(null);
    setConnectHint(false);
    if (result.ok) {
      await refetch();
      toast.success(`Connected with ${wallet.info.name}`);
      onConnected?.();
      return;
    }
    if (!result.rejected) {
      toast.error(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {wallets.length > 0 && (
        <div className="flex flex-col gap-2">
          {wallets.map((wallet) => (
            <button
              className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted disabled:opacity-60"
              data-testid={`connect-wallet-${wallet.info.rdns}`}
              disabled={connecting !== null}
              key={wallet.info.rdns}
              onClick={() => handleConnect(wallet)}
              type="button"
            >
              <WalletIcon alt={wallet.info.name} src={wallet.info.icon} />
              <span className="flex-1 font-medium text-sm">
                {wallet.info.name}
              </span>
              {connecting === wallet.info.rdns ? (
                <Spinner className="size-4" />
              ) : (
                <ArrowRight className="size-4 text-muted-foreground" />
              )}
            </button>
          ))}
          {connectHint && (
            <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Check your wallet for a connection prompt.
              </span>
              <button
                className="ml-3 shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
                onClick={() => {
                  setConnecting(null);
                  setConnectHint(false);
                  clearHintTimer();
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {installable.length > 0 && (
        <div>
          <p className="mb-2 text-muted-foreground text-xs">
            {wallets.length > 0
              ? "Don't see your wallet? Install one:"
              : "No wallet detected. Install one to continue:"}
          </p>
          <div className="flex flex-col gap-2">
            {installable.map((w) => (
              <a
                className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted"
                href={w.installUrl}
                key={w.rdns}
                rel="noopener noreferrer"
                target="_blank"
              >
                <WalletIcon alt={w.name} src={w.icon} />
                <span className="flex-1 font-medium text-sm">{w.name}</span>
                <span className="text-muted-foreground text-xs">Install</span>
                <ArrowUpRight className="size-4 text-muted-foreground" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
