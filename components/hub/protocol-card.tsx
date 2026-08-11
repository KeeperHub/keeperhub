"use client";

import { Box, ChevronRight, ExternalLink, Eye, Pencil } from "lucide-react";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getChainName, getExplorerUrl } from "@/lib/chain-utils";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

type ProtocolCardProps = {
  protocol: ProtocolDefinition;
  onSelect: (slug: string) => void;
};

function ActionTypeCounts({
  actions,
}: {
  actions: ProtocolDefinition["actions"];
}): React.ReactElement {
  let readCount = 0;
  let writeCount = 0;
  for (const a of actions) {
    if (a.type === "read") {
      readCount++;
    } else {
      writeCount++;
    }
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {readCount > 0 && (
        <span className="flex items-center gap-1">
          <Eye className="size-3" />
          {readCount} read
        </span>
      )}
      {writeCount > 0 && (
        <span className="flex items-center gap-1">
          <Pencil className="size-3" />
          {writeCount} write
        </span>
      )}
    </div>
  );
}

function ChainBadges({
  addresses,
}: {
  addresses: Record<string, string>;
}): React.ReactElement {
  const chains = Object.keys(addresses);
  const visible = chains.slice(0, 3);
  const remaining = chains.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((chain) => (
        <span
          className="rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-medium text-[var(--color-text-accent)] text-[10px]"
          key={chain}
        >
          {getChainName(chain)}
        </span>
      ))}
      {remaining > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground text-[10px]">
              +{remaining}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {chains
              .slice(3)
              .map((c) => getChainName(c))
              .join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function collectChains(
  contracts: ProtocolDefinition["contracts"]
): Record<string, string> {
  const all: Record<string, string> = {};
  for (const contract of Object.values(contracts)) {
    for (const [chain, addr] of Object.entries(contract.addresses)) {
      if (!all[chain]) {
        all[chain] = addr;
      }
    }
  }
  return all;
}

export function ProtocolCard({
  protocol,
  onSelect,
}: ProtocolCardProps): React.ReactElement {
  const allChains = collectChains(protocol.contracts);

  const chainEntries = Object.entries(allChains);
  const firstChainEntry = chainEntries[0];
  const explorerUrl =
    firstChainEntry?.[0] && firstChainEntry[1]
      ? getExplorerUrl(firstChainEntry[0], firstChainEntry[1])
      : null;

  return (
    <Card
      className="group cursor-pointer border border-border/50 bg-sidebar py-0 transition-colors hover:brightness-125"
      onClick={() => onSelect(protocol.slug)}
    >
      <CardHeader className="pb-2 pt-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-hub-icon-bg)]">
              {protocol.icon ? (
                <Image
                  alt={protocol.name}
                  className="rounded"
                  height={24}
                  src={protocol.icon}
                  width={24}
                />
              ) : (
                <Box className="size-4 text-[var(--color-text-accent)]" />
              )}
            </div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-sm leading-tight">
                {protocol.name}
              </h3>
              {explorerUrl && (
                <a
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  href={explorerUrl}
                  onClick={(e) => e.stopPropagation()}
                  rel="noopener noreferrer"
                  target="_blank"
                  title="View on explorer"
                >
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </div>
          <ChevronRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </CardHeader>

      <CardContent className="flex-1 pb-2 pt-0">
        <p className="text-muted-foreground text-xs">{protocol.description}</p>
      </CardContent>

      <div className="px-6 pb-2">
        <ChainBadges addresses={allChains} />
      </div>

      <CardFooter className="border-t border-border/30 pb-3 pt-2">
        <ActionTypeCounts actions={protocol.actions} />
        <span className="ml-auto text-muted-foreground text-xs">
          {protocol.actions.length}{" "}
          {protocol.actions.length === 1 ? "action" : "actions"}
        </span>
      </CardFooter>
    </Card>
  );
}
