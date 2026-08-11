"use client";

import { ExternalLinkIcon } from "lucide-react";
import { getChainDisplayName, getExplorerAddressUrl } from "./chain-prefixes";

type TargetLink = {
  address: string;
  explorerUrl?: string | null;
};

type Props = {
  chainId: number;
  targets: readonly TargetLink[];
};

function truncate(addr: string): string {
  if (addr.length < 12) {
    return addr;
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function PolicyProtocolTargets({
  chainId,
  targets,
}: Props): React.ReactElement | null {
  if (targets.length === 0) {
    return null;
  }
  const chainName = getChainDisplayName(chainId);
  return (
    <div className="space-y-2 rounded bg-muted/20 p-2 text-xs">
      <div>
        <div className="font-medium text-foreground/80">
          Allowed contracts on {chainName}
        </div>
        <div className="text-muted-foreground">
          Workflows on this Safe can only call the contracts below; anything
          else reverts on chain.
        </div>
      </div>
      <ul className="space-y-1">
        {targets.map((t) => {
          const explorerUrl =
            t.explorerUrl ?? getExplorerAddressUrl(chainId, t.address);
          return (
            <li className="flex items-center gap-2 font-mono" key={t.address}>
              {explorerUrl ? (
                <a
                  className="inline-flex items-center gap-1 text-foreground hover:underline"
                  href={explorerUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {truncate(t.address)}
                  <ExternalLinkIcon className="h-3 w-3 text-muted-foreground" />
                </a>
              ) : (
                <span className="text-muted-foreground">
                  {truncate(t.address)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
