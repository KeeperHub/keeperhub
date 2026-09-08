"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { getExplorerAddressUrl } from "@/components/safe/chain-prefixes";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toChecksumAddress } from "@/lib/address-utils";
import { cn } from "@/lib/utils";

const COPIED_FOR_MS = 1500;

/**
 * The full address under an account's name, with the two things anyone wants
 * from an address: a copy of it, and the chain's view of it.
 */
export function AccountAddress({
  address,
  chainId,
  isEvm,
  always = false,
}: {
  address: string;
  /** Safes are on one chain, so only they can link to an explorer. */
  chainId?: number;
  isEvm: boolean;
  /** In a list the controls wait for the pointer; on a page of their own,
   * where there is one address and it is the subject, they stay put. */
  always?: boolean;
}): React.ReactElement {
  const reveal = always
    ? ""
    : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100";
  const [copied, setCopied] = useState(false);
  const display = isEvm ? toChecksumAddress(address) : address;
  const explorerUrl = chainId ? getExplorerAddressUrl(chainId, display) : null;

  const copy = (event: React.MouseEvent): void => {
    event.stopPropagation();
    navigator.clipboard.writeText(display);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FOR_MS);
  };

  return (
    <span className="group flex items-center gap-1.5">
      <span className="break-all font-mono text-muted-foreground text-xs">
        {display}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Copy address"
            className={cn(
              "shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-foreground",
              reveal
            )}
            onClick={copy}
            type="button"
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy address"}</TooltipContent>
      </Tooltip>
      {explorerUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              aria-label="View on explorer"
              className={cn(
                "shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-foreground",
                reveal
              )}
              href={explorerUrl}
              onClick={(event) => event.stopPropagation()}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>View on explorer</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
