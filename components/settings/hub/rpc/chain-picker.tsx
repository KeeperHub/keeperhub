"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RpcChainType } from "@/lib/rpc/engine/types";
import type { RpcChainOption } from "@/lib/rpc/org-rpc-client";
import { cn } from "@/lib/utils";
import {
  CHAIN_TYPE_LABEL,
  groupChainOptions,
  SUBTLE_BADGE_CLASS,
} from "./model";

/** A chain's type and ID; the type is left out once the chain is no longer offered. */
export function ChainBadges({
  chain,
}: {
  chain: { chainId: number; chainType: RpcChainType | null };
}): React.ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chain.chainType && (
        <Badge
          className={cn(SUBTLE_BADGE_CLASS, "text-foreground/80")}
          variant="outline"
        >
          {CHAIN_TYPE_LABEL[chain.chainType]}
        </Badge>
      )}
      <Badge
        className={cn(SUBTLE_BADGE_CLASS, "font-mono text-foreground")}
        variant="outline"
      >
        {chain.chainId}
      </Badge>
    </span>
  );
}

function ChainItems({
  heading,
  chains,
  selected,
  onSelect,
}: {
  heading: string;
  chains: readonly RpcChainOption[];
  selected: RpcChainOption | null;
  onSelect: (chain: RpcChainOption) => void;
}): React.ReactNode {
  if (chains.length === 0) {
    return null;
  }
  return (
    <CommandGroup heading={heading}>
      {chains.map((chain) => (
        <CommandItem
          key={chain.chainId}
          keywords={[String(chain.chainId), CHAIN_TYPE_LABEL[chain.chainType]]}
          onSelect={() => onSelect(chain)}
          value={`${chain.name} ${chain.chainId}`}
        >
          <Check
            className={cn(
              "size-4 shrink-0",
              selected?.chainId === chain.chainId ? "opacity-100" : "opacity-0"
            )}
          />
          <span className="min-w-0 flex-1 truncate">{chain.name}</span>
          <ChainBadges chain={chain} />
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Searchable chain picker, mainnets first, each chain with its type and ID. */
export function ChainPicker({
  id,
  chains,
  value,
  onChange,
}: {
  id: string;
  chains: readonly RpcChainOption[];
  value: RpcChainOption | null;
  onChange: (chain: RpcChainOption) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupChainOptions(chains), [chains]);

  const select = (chain: RpcChainOption): void => {
    onChange(chain);
    setOpen(false);
  };

  return (
    <Popover modal onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="w-full justify-between font-normal"
          id={id}
          role="combobox"
          type="button"
          variant="outline"
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{value.name}</span>
              <ChainBadges chain={value} />
            </span>
          ) : (
            <span className="text-muted-foreground">Choose a chain</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command>
          <CommandInput placeholder="Search by name or chain ID" />
          <CommandList>
            <CommandEmpty>No chain matches.</CommandEmpty>
            <ChainItems
              chains={groups.mainnets}
              heading="Mainnets"
              onSelect={select}
              selected={value}
            />
            <ChainItems
              chains={groups.testnets}
              heading="Testnets"
              onSelect={select}
              selected={value}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
