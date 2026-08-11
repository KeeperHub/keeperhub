"use client";

import { ExternalLinkIcon } from "lucide-react";
import { getExplorerAddressUrl } from "./chain-prefixes";
import { PolicyProtocolTargets } from "./policy-protocol-targets";
import { POLICY_PERIOD_OPTIONS, type TokenRowValue } from "./policy-token-row";

type TargetLink = {
  address: string;
  explorerUrl?: string | null;
};

type PolicyProtocolCardViewProps = {
  chainId: number;
  tokens: readonly TokenRowValue[];
  targets: readonly TargetLink[];
};

function truncateAddress(addr: string): string {
  if (addr.length < 12) {
    return addr;
  }
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function periodLabel(seconds: number): string {
  const match = POLICY_PERIOD_OPTIONS.find((o) => o.seconds === seconds);
  return match?.label ?? `${seconds}s`;
}

export function PolicyProtocolCardView({
  chainId,
  tokens,
  targets,
}: PolicyProtocolCardViewProps): React.ReactElement {
  return (
    <div className="space-y-3">
      {tokens.length > 0 && (
        <ul className="space-y-1.5">
          {tokens.map((token) => {
            const tokenExplorerUrl = token.tokenAddress
              ? getExplorerAddressUrl(chainId, token.tokenAddress)
              : null;
            return (
              <li
                className="flex items-center justify-between rounded border bg-muted/20 px-3 py-2 text-sm"
                key={`${token.tokenAddress}-${token.periodSeconds}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{token.tokenSymbol}</span>
                  {token.tokenAddress &&
                    (tokenExplorerUrl ? (
                      <a
                        className="inline-flex items-center gap-1 font-mono text-muted-foreground text-xs hover:underline"
                        href={tokenExplorerUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {truncateAddress(token.tokenAddress)}
                        <ExternalLinkIcon className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="font-mono text-muted-foreground text-xs">
                        {truncateAddress(token.tokenAddress)}
                      </span>
                    ))}
                </div>
                <div className="text-muted-foreground text-xs">
                  cap{" "}
                  <span className="text-foreground">
                    {token.amountHuman} {token.tokenSymbol}
                  </span>{" "}
                  · {periodLabel(token.periodSeconds).toLowerCase()}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {tokens.length === 0 && (
        <div className="rounded border bg-muted/20 px-3 py-2 text-muted-foreground text-xs">
          No tokens configured.
        </div>
      )}

      <PolicyProtocolTargets chainId={chainId} targets={targets} />
    </div>
  );
}
