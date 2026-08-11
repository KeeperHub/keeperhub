"use client";

import { ExternalLinkIcon } from "lucide-react";
import { getExplorerAddressUrl } from "./chain-prefixes";

type Props = {
  chainId: number;
  address: string;
  className?: string;
  full?: boolean;
};

const TRUNCATE_THRESHOLD = 12;

function truncate(addr: string): string {
  if (addr.length < TRUNCATE_THRESHOLD) {
    return addr;
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function AddressWithExplorer({
  chainId,
  address,
  className,
  full,
}: Props): React.ReactElement {
  const display = full ? address : truncate(address);
  const explorerUrl = getExplorerAddressUrl(chainId, address);

  if (!explorerUrl) {
    return (
      <span
        className={`font-mono text-muted-foreground ${className ?? ""}`.trim()}
      >
        {display}
      </span>
    );
  }

  return (
    <a
      className={`inline-flex items-center gap-1 font-mono text-muted-foreground hover:underline ${className ?? ""}`.trim()}
      href={explorerUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      {display}
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  );
}
