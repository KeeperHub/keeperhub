"use client";

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useDebounce } from "@/lib/hooks/use-debounce";
import type { CatalogChain, CatalogProtocol } from "@/lib/policy/ui";
import { cn } from "@/lib/utils";

/** Any address, rather than one the protocol registry already knows. */
export const CUSTOM_CONTRACT = "custom";

/** How long to wait after the last keystroke before filtering. */
const SEARCH_DELAY_MS = 200;

/** Rendered at once. The rest are reachable by narrowing the search. */
const VISIBLE_LIMIT = 60;

export type ContractOption = {
  key: string;
  protocolSlug: string;
  protocolName: string;
  label: string;
  chainId: number;
  address: string;
};

/**
 * Flatten the registry into one option per deployment.
 *
 * A contract exists once per chain it is deployed on, and those are different
 * addresses, so offering the contract without its chain would let an author
 * pick a deployment that does not exist where they meant it.
 */
export function buildContractOptions(
  protocols: readonly CatalogProtocol[],
  chainId: number | null
): ContractOption[] {
  const options: ContractOption[] = [];
  for (const protocol of protocols) {
    for (const contract of protocol.contracts) {
      for (const deployment of contract.deployments) {
        if (chainId !== null && deployment.chainId !== chainId) {
          continue;
        }
        options.push({
          key: `${protocol.slug}:${contract.key}:${deployment.chainId}`,
          protocolSlug: protocol.slug,
          protocolName: protocol.name,
          label: contract.label,
          chainId: deployment.chainId,
          address: deployment.address,
        });
      }
    }
  }
  return options;
}

function matches(option: ContractOption, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const query = needle.toLowerCase();
  return (
    option.protocolName.toLowerCase().includes(query) ||
    option.label.toLowerCase().includes(query) ||
    option.address.toLowerCase().includes(query)
  );
}

/**
 * Pick a contract from the protocol registry, by searching rather than
 * scrolling.
 *
 * The registry holds hundreds of deployments, which is past the point where a
 * plain list is usable. Filtering is debounced so typing stays responsive, and
 * the rendered set is capped so a broad query does not mount every row.
 */
export function ContractCombobox({
  protocols,
  chains,
  chainId,
  value,
  onSelect,
  onSelectCustom,
}: {
  protocols: readonly CatalogProtocol[];
  chains: readonly CatalogChain[];
  /** Restricts the list to one chain. Null shows every deployment. */
  chainId: number | null;
  /** The selected option key, or the custom sentinel. */
  value: string;
  onSelect: (option: ContractOption) => void;
  onSelectCustom: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, SEARCH_DELAY_MS);

  const options = useMemo(
    () => buildContractOptions(protocols, chainId),
    [protocols, chainId]
  );

  const filtered = useMemo(
    () => options.filter((option) => matches(option, debounced)),
    [options, debounced]
  );

  const chainName = useMemo(() => {
    const byId = new Map(chains.map((chain) => [chain.chainId, chain.name]));
    return (id: number) => byId.get(id) ?? `Chain ${id}`;
  }, [chains]);

  const selected = options.find((option) => option.key === value);
  const label = selected
    ? `${selected.protocolName} - ${selected.label}`
    : "An address not listed here";

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="w-full justify-between font-normal"
          role="combobox"
          variant="outline"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        {/* cmdk's own filter is off: the list is filtered here, debounced. */}
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setQuery}
            placeholder="Search protocols and contracts"
            value={query}
          />
          <CommandList>
            <CommandEmpty>
              No contract matches that. Choose Another address to name one by
              hand.
            </CommandEmpty>

            <CommandItem
              onSelect={() => {
                onSelectCustom();
                setOpen(false);
              }}
              value={CUSTOM_CONTRACT}
            >
              <Check
                className={cn(
                  "size-4",
                  value === CUSTOM_CONTRACT ? "opacity-100" : "opacity-0"
                )}
              />
              <div className="flex min-w-0 flex-col">
                <span>An address not listed here</span>
                <span className="text-muted-foreground text-xs">
                  Type it into the Address field below
                </span>
              </div>
            </CommandItem>

            {filtered.slice(0, VISIBLE_LIMIT).map((option) => (
              <CommandItem
                key={option.key}
                onSelect={() => {
                  onSelect(option);
                  setOpen(false);
                }}
                value={option.key}
              >
                <Check
                  className={cn(
                    "size-4",
                    value === option.key ? "opacity-100" : "opacity-0"
                  )}
                />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {option.protocolName} - {option.label}
                  </span>
                  <span className="font-mono text-muted-foreground text-xs">
                    {chainName(option.chainId)} · {option.address}
                  </span>
                </div>
              </CommandItem>
            ))}

            {filtered.length > VISIBLE_LIMIT && (
              <p className="px-2 py-1.5 text-muted-foreground text-xs">
                {filtered.length - VISIBLE_LIMIT} more match. Narrow the search
                to reach them.
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
