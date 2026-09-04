"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Pin,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { ReceiveModal } from "@/components/overlays/receive-modal";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { getDisplayChainName } from "@/components/overlays/wallet/chain-utils";
import { WithdrawModal } from "@/components/overlays/withdraw-modal";
import { Button } from "@/components/ui/button";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { cn } from "@/lib/utils";
import { useDefaultAccount } from "@/lib/wallet/use-default-account";
import {
  accountSlug,
  accountTitle,
} from "@/lib/wallet/use-wallet-accounts";
import {
  type DigestAsset,
  useWalletDigest,
  type WalletTotal,
} from "@/lib/wallet/use-wallet-digest";

const COPIED_FOR_MS = 1500;
const ASSETS_SHOWN = 5;
const SKELETON_ROWS = ["a", "b", "c"] as const;

const USD = new Intl.NumberFormat(undefined, {
  currency: "USD",
  style: "currency",
});

function formatBalance(balance: string): string {
  const n = Number.parseFloat(balance);
  if (!Number.isFinite(n) || n === 0) {
    return "0";
  }
  return n < 0.000_001
    ? "<0.000001"
    : n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function isEvmAccount(account: WalletAccountKind): boolean {
  return account.kind === "safe" || account.family === "evm";
}

/**
 * The short name a person reads. The signer is named for its family rather
 * than a chain: it is the same address on every EVM network, so naming it
 * "Ethereum" would both understate it and collide with the Ethereum row in the
 * asset list.
 */
function shortTitle(account: WalletAccountKind): string {
  if (account.kind === "safe") {
    return `Safe · ${account.chainName}`;
  }
  return account.family === "solana" ? "Solana" : "EVM";
}

function CopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={label}
      className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_FOR_MS);
      }}
      type="button"
    >
      {copied ? (
        <Check className="size-3.5" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

function AccountIcon({
  account,
  className,
}: {
  account: WalletAccountKind;
  className?: string;
}): React.ReactElement {
  const Icon = account.kind === "safe" ? ShieldCheck : Wallet;
  return <Icon className={cn("size-4 shrink-0", className)} />;
}

/** One network's row in the account switcher. */
function SwitcherRow({
  account,
  isDefault,
  onPin,
  striped,
}: {
  account: WalletAccountKind;
  isDefault: boolean;
  onPin: () => void;
  striped: boolean;
}): React.ReactElement {
  const evm = isEvmAccount(account);
  const display = evm ? toChecksumAddress(account.address) : account.address;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-sm py-1.5 pr-1 pl-8 hover:bg-accent",
        striped && "bg-muted/40"
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm">
        {shortTitle(account)}
      </span>
      <span className="shrink-0 font-mono text-muted-foreground text-xs">
        {truncateAddress(display)}
      </span>
      <CopyButton
        label={`Copy ${shortTitle(account)} address`}
        value={display}
      />
      <button
        aria-label={
          isDefault
            ? `${shortTitle(account)} is shown by default`
            : `Show ${shortTitle(account)} by default`
        }
        aria-pressed={isDefault}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          isDefault
            ? "text-foreground"
            : "text-muted-foreground/40 hover:text-foreground"
        )}
        onClick={onPin}
        type="button"
      >
        <Pin className={cn("size-3.5", isDefault && "fill-current")} />
      </button>
    </div>
  );
}

function TotalBalance({
  total,
  loading,
}: {
  total: WalletTotal;
  loading: boolean;
}): React.ReactElement {
  if (loading) {
    return <Skeleton className="h-8 w-32" />;
  }
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-semibold text-2xl tabular-nums">
        {USD.format(total.usd)}
      </span>
      {total.unpriced > 0 && (
        <span className="text-muted-foreground text-xs">
          {total.unpriced === 1
            ? "+ 1 asset with no price"
            : `+ ${total.unpriced} assets with no price`}
        </span>
      )}
    </div>
  );
}

function AssetRow({
  asset,
  striped,
}: {
  asset: DigestAsset;
  striped: boolean;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-sm px-2 py-1",
        striped && "bg-muted/40"
      )}
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-sm">
          {formatBalance(asset.balance)} {asset.symbol}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {getDisplayChainName(asset.chainName)}
          {asset.isTestnet && " · Testnet"}
        </span>
      </div>
      {/* A placeholder rather than an empty column: nothing there reads as a
          value that failed to load, when the asset simply has no price. */}
      {asset.usdValue === null ? (
        <span className="shrink-0 text-muted-foreground text-sm">-</span>
      ) : (
        <span className="shrink-0 font-mono text-sm tabular-nums">
          {USD.format(asset.usdValue)}
        </span>
      )}
    </div>
  );
}

/**
 * What the toolbar wallet pill opens into: the address people hand out, what
 * it is worth, the two things they do with it, and what it holds.
 */
export function WalletDigestMenu({
  organizationId,
  onClose,
}: {
  organizationId: string | null;
  /** Anything that takes over the screen dismisses the menu behind it. */
  onClose: () => void;
}): React.ReactElement {
  const { push } = useOverlay();
  const { isOwner, isLoading: roleLoading } = useActiveMember();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const digest = useWalletDigest(organizationId);
  const { account, isDefault, setDefault } = useDefaultAccount(
    organizationId,
    digest.accounts
  );
  const shown = digest.assets.slice(0, ASSETS_SHOWN);
  const hidden = digest.assets.length - shown.length;
  const evm = account ? isEvmAccount(account) : true;
  const display = account
    ? evm
      ? toChecksumAddress(account.address)
      : account.address
    : "";

  const send = (): void => {
    if (!isOwner) {
      return;
    }
    const assets = digest.sendableAssets();
    if (assets.length === 0) {
      // Closing on a dead click reads as the menu breaking, so it stays open
      // and says why instead.
      toast.error("Nothing to send from this wallet yet");
      return;
    }
    onClose();
    push(WithdrawModal, {
      assets,
      walletAddress: account?.address ?? "",
    });
  };

  const receive = (): void => {
    if (!account) {
      return;
    }
    onClose();
    push(ReceiveModal, {
      accountName: accountTitle(account),
      address: account.address,
      chainName: account.kind === "safe" ? account.chainName : undefined,
      isEvm: evm,
    });
  };

  return (
    <div className="flex flex-col">
      {/* The other addresses open inside this panel rather than flying out of
          it: the menu is pinned under the toolbar, and a side panel would
          swing across the page to reach the room it needs. */}
      <button
        aria-expanded={switcherOpen}
        className="flex items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent"
        onClick={() => setSwitcherOpen((open) => !open)}
        type="button"
      >
        {account ? (
          <>
            <AccountIcon account={account} className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {shortTitle(account)}
            </span>
            <span className="shrink-0 font-mono text-muted-foreground text-xs">
              {truncateAddress(display)}
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                switcherOpen && "rotate-180"
              )}
            />
          </>
        ) : (
          <Skeleton className="h-5 w-full" />
        )}
      </button>

      {switcherOpen && (
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          {digest.accounts.map((row, index) => (
            <SwitcherRow
              account={row}
              isDefault={isDefault(row)}
              key={accountSlug(row)}
              onPin={() => setDefault(row)}
              striped={index % 2 === 1}
            />
          ))}
        </div>
      )}

      <DropdownMenuSeparator className="mx-0" />

      <div className="flex flex-col items-center gap-3 px-3 py-4">
        <TotalBalance loading={digest.balancesLoading} total={digest.total} />
        {/* Both halves of a wallet stay on screen. Withdrawing is owner-only
            and the endpoint refuses anyone else, so a member sees Send
            disabled with the reason rather than a control that went missing. */}
        <div className="grid w-full grid-cols-2 gap-2">
          <Button
            className="w-full"
            disabled={roleLoading || !isOwner}
            onClick={send}
            size="sm"
          >
            <ArrowUpRight className="size-4" />
            Send
          </Button>
          <Button
            className="w-full"
            onClick={receive}
            size="sm"
            variant="outline"
          >
            <ArrowDownLeft className="size-4" />
            Receive
          </Button>
        </div>
        {!(roleLoading || isOwner) && (
          <p className="text-center text-muted-foreground text-xs">
            Only an organization owner can send funds.
          </p>
        )}
      </div>

      <DropdownMenuSeparator className="mx-0" />

      <div className="flex flex-col gap-1 px-3 py-2">
        {digest.balancesLoading &&
          SKELETON_ROWS.map((key) => (
            <Skeleton className="h-9 w-full" key={key} />
          ))}
        {!digest.balancesLoading && shown.length === 0 && (
          <span className="py-2 text-center text-muted-foreground text-xs">
            Nothing funded yet
          </span>
        )}
        {!digest.balancesLoading &&
          shown.map((asset, index) => (
            <AssetRow asset={asset} key={asset.key} striped={index % 2 === 1} />
          ))}
        {/* No link out: the gear in the pill already goes to the wallets page.
            The count stays so a truncated list does not read as the whole of
            what the wallet holds. */}
        {!digest.balancesLoading && hidden > 0 && (
          <span className="px-2 py-1 text-muted-foreground text-xs">
            + {hidden} more
          </span>
        )}
      </div>

    </div>
  );
}
