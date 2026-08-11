"use client";

import { ChevronRight, InfoIcon, ShieldCheck, Wallet } from "lucide-react";
import { getExplorerAddressUrl } from "@/components/safe/chain-prefixes";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { truncateAddress } from "@/lib/address-utils";
import { solscanAccountUrl } from "@/lib/solana-explorer";

export type WalletAccountKind =
  | {
      kind: "turnkey";
      address: string;
      family: "evm" | "solana";
      /** For family === "solana": whether the org's Solana context is devnet
       *  (no mainnet Solana chain enabled), so the explorer link uses the
       *  devnet cluster. */
      solanaIsTestnet?: boolean;
    }
  | {
      kind: "safe";
      safeId: string;
      address: string;
      chainId: number;
      chainName: string;
      isSigningActive: boolean;
    };

type AccountRowProps = {
  account: WalletAccountKind;
  /** Native asset balance for the wallet's primary chain (Safe) or "Multi-chain" (Turnkey). */
  subtitle?: string;
  onClick: () => void;
  /** Whether the current member can flip the signing toggle on a Safe row. */
  isAdmin?: boolean;
  /** Fired after a Safe's signing toggle PATCH succeeds; parent updates state. */
  onSigningChange?: (safeId: string, next: boolean) => void;
};

const TURNKEY_DEFAULT_EXPLORER_CHAIN = 1;
const MULTI_CHAIN_LABEL = "Multi-chain";

function stop(event: React.MouseEvent | React.KeyboardEvent): void {
  event.stopPropagation();
}

export function AccountRow({
  account,
  subtitle,
  onClick,
  isAdmin = false,
  onSigningChange,
}: AccountRowProps): React.ReactElement {
  const isTurnkey = account.kind === "turnkey";
  const isSolanaTurnkey = account.kind === "turnkey" && account.family === "solana";
  const Icon = isTurnkey ? Wallet : ShieldCheck;

  let title: string;
  if (account.kind === "safe") {
    title = `Safe · ${account.chainName}`;
  } else {
    title =
      account.family === "solana"
        ? "Turnkey EOA (SVM Compatible)"
        : "Turnkey EOA (EVM Compatible)";
  }
  const addressLine = truncateAddress(account.address);

  let explorerUrl: string | null;
  if (account.kind === "safe") {
    explorerUrl = getExplorerAddressUrl(account.chainId, account.address);
  } else if (account.family === "solana") {
    explorerUrl = solscanAccountUrl(account.address, account.solanaIsTestnet);
  } else {
    explorerUrl = getExplorerAddressUrl(
      TURNKEY_DEFAULT_EXPLORER_CHAIN,
      account.address
    );
  }

  const handleKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    // Outer is a div (role=button) instead of a real <button>: the row needs
    // to host nested interactive children (explorer link, tooltip trigger)
    // and HTML disallows nested buttons.
    // biome-ignore lint/a11y/useSemanticElements: row contains nested <a>/<button> children
    <div
      aria-label={`Open ${title}`}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      onKeyDown={handleKey}
      role="button"
      tabIndex={0}
    >
      <div className="rounded-md border bg-muted/30 p-2 text-muted-foreground">
        <Icon aria-hidden="true" className="h-4 w-4" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-sm">{title}</span>
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          {explorerUrl ? (
            <a
              className="font-mono transition-colors hover:text-foreground hover:underline"
              href={explorerUrl}
              onClick={stop}
              onKeyDown={stop}
              rel="noopener noreferrer"
              target="_blank"
            >
              {addressLine}
            </a>
          ) : (
            <span className="font-mono">{addressLine}</span>
          )}
          {subtitle && <span>·</span>}
          {subtitle && <span>{subtitle}</span>}
          {subtitle === MULTI_CHAIN_LABEL && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="What does Multi-chain mean?"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  onClick={stop}
                  onKeyDown={stop}
                  type="button"
                >
                  <InfoIcon className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs" side="bottom">
                The Turnkey EOA holds the same address on every supported EVM
                chain. It also acts as the default signer on chains where you
                haven't deployed a Safe yet, so workflows can still execute.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {isTurnkey && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="What does Signer mean?"
              className="shrink-0 rounded border border-muted-foreground/30 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60"
              onClick={stop}
              onKeyDown={stop}
              type="button"
            >
              Signer
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs" side="bottom">
            {isSolanaTurnkey
              ? "The key that signs every Solana workflow transaction, held in your Turnkey wallet."
              : "The key that signs every workflow transaction. Always your Turnkey EOA, owner of every Safe. Also signs directly on chains where you haven't deployed a Safe yet."}
          </TooltipContent>
        </Tooltip>
      )}
      {!isTurnkey && (
        // Don't let clicks on the inline toggle bubble to the row's onClick
        // (which would open the detail overlay).
        // biome-ignore lint/a11y/useKeyWithClickEvents: the Switch handles its own keyboard interaction
        <div className="shrink-0" onClick={stop} onKeyDown={stop}>
          <SafeSigningToggle
            chainLabel={account.chainName}
            compact
            isActive={account.isSigningActive}
            isAdmin={isAdmin}
            onChange={(next) => onSigningChange?.(account.safeId, next)}
            safeId={account.safeId}
          />
        </div>
      )}

      <ChevronRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </div>
  );
}
