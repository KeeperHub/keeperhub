"use client";

import { Copy, Loader2, Plus, Settings, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WalletDigestMenu } from "@/components/workflow/wallet-digest-menu";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient, useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { usePinnedAccount } from "@/lib/wallet/use-default-account";
import { useWalletInfo } from "@/lib/wallet/use-wallet-info";
import { useWalletProvisioning } from "@/lib/wallet/use-wallet-provisioning";

/**
 * Compact toolbar affordance for the organization wallet.
 *
 * - Shows the truncated wallet address when a wallet exists (click opens a
 *   digest of the org's accounts and balances; the gear goes to the wallet
 *   settings and the clipboard copies the full checksummed address).
 * - Shows a "Create wallet" button when the user is signed in but has no
 *   wallet yet, which lands on the same page: creating one is the first thing
 *   it offers.
 * - Renders nothing for anonymous / unverified users to keep the toolbar
 *   clean on first load.
 */
export function WalletToolbarButton(): React.ReactElement | null {
  const { data: session, isPending } = useSession();

  // NAV-04: defer mounting the inner button (and its `useWalletInfo` hook,
  // which auto-fires `useActiveOrganization` and triggers a 401 for
  // anonymous users) until the session resolves to a verified user.
  if (isPending) {
    return null;
  }

  if (!session?.user || isAnonymousUser(session.user)) {
    return null;
  }

  // Wallet (SIWE) accounts have a synthetic email that is never verified, but
  // they authenticate by signature and own a wallet, so the unverified gate is
  // email/OAuth only and never hides the wallet button from wallet users.
  if (
    session.user.emailVerified !== true &&
    !isWalletEmail(session.user.email)
  ) {
    return null;
  }

  return <AuthenticatedWalletToolbarButton />;
}

function AuthenticatedWalletToolbarButton(): React.ReactElement | null {
  const router = useRouter();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { hasWallet, walletAddress, isLoading } = useWalletInfo();
  const { isProvisioning } = useWalletProvisioning();

  const pinned = usePinnedAccount(activeOrg?.id ?? null);
  const [menuOpen, setMenuOpen] = useState(false);

  const walletsHref = activeOrg?.id
    ? `/settings/${activeOrg.id}/wallets`
    : "/settings";

  if (isLoading && !walletAddress) {
    return null;
  }

  if (!hasWallet || !walletAddress) {
    // Signup-time provisioning in flight: show a silent setup indicator
    // instead of the manual "Create wallet" affordance.
    if (isProvisioning) {
      return (
        <div
          className="flex h-9 items-center gap-2 rounded-md border bg-secondary px-3 text-secondary-foreground text-sm"
          data-testid="wallet-toolbar-provisioning"
        >
          <Loader2 className="size-4 animate-spin" />
          <span className="hidden sm:inline">Setting up wallet</span>
        </div>
      );
    }

    return (
      <Button
        className="h-9"
        data-tour="create-wallet"
        onClick={() => router.push(walletsHref)}
        size="sm"
        variant="outline"
      >
        <Plus className="size-4" />
        <span className="hidden sm:inline">Create wallet</span>
        <span className="sm:hidden">Wallet</span>
      </Button>
    );
  }

  // Whichever account was pinned in the menu, falling back to the EVM signer.
  const shownAddress = pinned?.address ?? walletAddress;
  const shownIsEvm = pinned ? pinned.isEvm : true;
  const fullAddress = shownIsEvm
    ? toChecksumAddress(shownAddress)
    : shownAddress;

  const handleOpenWallet = (): void => {
    router.push(walletsHref);
  };

  const handleCopy = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    navigator.clipboard.writeText(fullAddress);
    toast.success("Address copied to clipboard");
  };

  return (
    <div className="flex h-9 items-center rounded-md border bg-secondary text-secondary-foreground">
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex h-full items-center gap-2 rounded-l-md px-3 font-medium text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            data-testid="wallet-toolbar-address"
            type="button"
          >
            <Wallet className="size-4 shrink-0" />
            <span className="font-mono text-xs">
              {truncateAddress(fullAddress)}
            </span>
          </button>
        </DropdownMenuTrigger>
        {/* Radix mounts this only while open, so the digest's fetches are the
            price of asking rather than of every page that draws the header. */}
        {/* Anchored to the left edge of the pill: the trigger is only the
            address segment, so aligning to its end hung the panel out to the
            left of the wallet it belongs to. */}
        <DropdownMenuContent
          align="start"
          className="w-80 p-0"
          collisionPadding={12}
        >
          <WalletDigestMenu
            onClose={() => setMenuOpen(false)}
            organizationId={activeOrg?.id ?? null}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Copy wallet address"
            className="flex h-full items-center px-2 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
            data-testid="wallet-toolbar-copy"
            onClick={handleCopy}
            type="button"
          >
            <Copy className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy address</TooltipContent>
      </Tooltip>
      <div className="h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Wallet settings"
            className="flex h-full items-center rounded-r-md px-2 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
            data-testid="wallet-toolbar-settings"
            onClick={handleOpenWallet}
            type="button"
          >
            <Settings className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Wallet settings</TooltipContent>
      </Tooltip>
    </div>
  );
}
