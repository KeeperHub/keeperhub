"use client";

import { BookmarkPlus, Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { addressBookApi } from "@/lib/api-client";
import { getExplorerUrl } from "@/lib/chain-utils";

type AddressActionsProps = {
  address: string;
  chainId: number;
  /** When false (anonymous), the add-to-address-book action is hidden. */
  canBookmark?: boolean;
};

const iconClass =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)]";

/**
 * Subtle explorer / copy / add-to-address-book actions for a read-only address
 * field, mirroring the affordances used in the wallet modal and node config.
 */
export function AddressActions({
  address,
  chainId,
  canBookmark,
}: AddressActionsProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const explorerUrl = getExplorerUrl(String(chainId), address);

  const handleCopy = (): void => {
    navigator.clipboard
      .writeText(address)
      .then(() => {
        setCopied(true);
        toast.success("Address copied");
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Couldn't copy address"));
  };

  const handleBookmark = (): void => {
    addressBookApi
      .create({ label: `Scanned ${address.slice(0, 6)}…`, address })
      .then(() => {
        setSaved(true);
        toast.success("Added to address book");
      })
      .catch(() => toast.error("Couldn't add to address book"));
  };

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button className={iconClass} onClick={handleCopy} type="button">
            {copied ? (
              <Check className="size-3.5 text-[var(--color-text-accent)]" />
            ) : (
              <Copy className="size-3.5" />
            )}
            <span className="sr-only">Copy address</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy address</TooltipContent>
      </Tooltip>

      {explorerUrl ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              className={iconClass}
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">View on explorer</span>
            </a>
          </TooltipTrigger>
          <TooltipContent>View on explorer</TooltipContent>
        </Tooltip>
      ) : null}

      {canBookmark ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={iconClass}
              disabled={saved}
              onClick={handleBookmark}
              type="button"
            >
              {saved ? (
                <Check className="size-3.5 text-[var(--color-text-accent)]" />
              ) : (
                <BookmarkPlus className="size-3.5" />
              )}
              <span className="sr-only">Add to address book</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Add to address book</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
