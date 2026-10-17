"use client";

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
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
import { useDebounce } from "@/lib/hooks/use-debounce";
import type { PolicyOption } from "@/lib/policy/ui";
import { cn } from "@/lib/utils";

/** How long to wait after the last keystroke before filtering. */
const SEARCH_DELAY_MS = 200;

/**
 * Below this many options a search box costs more than it saves, so it is
 * hidden. The control is otherwise identical, which keeps every dropdown in
 * the editor behaving the same way.
 */
const SEARCH_THRESHOLD = 8;

/** The shared option shape, so every list in the section is built one way. */
export type SearchableOption = PolicyOption;

function matches(option: SearchableOption, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const query = needle.toLowerCase();
  return (
    option.label.toLowerCase().includes(query) ||
    (option.hint?.toLowerCase().includes(query) ?? false) ||
    option.value.toLowerCase().includes(query)
  );
}

/** Preserves the order groups first appear in, so the caller controls it. */
function groupOptions(
  options: readonly SearchableOption[]
): [string, SearchableOption[]][] {
  const groups = new Map<string, SearchableOption[]>();
  for (const option of options) {
    const key = option.group ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.push(option);
    } else {
      groups.set(key, [option]);
    }
  }
  return [...groups.entries()];
}

/**
 * A select that can be searched.
 *
 * Every prefilled list in the editor uses this, because which lists are long is
 * not knowable in advance: an organization with two projects and one with two
 * hundred see the same control, and the second one is unusable without a search
 * box.
 */
export function SearchableSelect({
  id,
  options,
  value,
  placeholder,
  searchPlaceholder,
  className,
  onChange,
}: {
  id?: string;
  options: readonly SearchableOption[];
  value: string;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, SEARCH_DELAY_MS);

  const filtered = useMemo(
    () => options.filter((option) => matches(option, debounced)),
    [options, debounced]
  );
  const groups = useMemo(() => groupOptions(filtered), [filtered]);
  const selected = options.find((option) => option.value === value);
  const searchable = options.length >= SEARCH_THRESHOLD;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
          id={id}
          role="combobox"
          variant="outline"
        >
          <span
            className={cn("truncate", !selected && "text-muted-foreground")}
          >
            {selected?.label ?? placeholder ?? "Select"}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        {/* cmdk's own filter is off: filtering happens above, debounced. */}
        <Command shouldFilter={false}>
          {searchable && (
            <CommandInput
              onValueChange={setQuery}
              placeholder={searchPlaceholder ?? "Search"}
              value={query}
            />
          )}
          <CommandList>
            <CommandEmpty>Nothing matches that.</CommandEmpty>
            {groups.map(([group, entries]) => {
              const items = entries.map((option) => (
                <CommandItem
                  key={option.value}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  value={option.value}
                >
                  <Check
                    className={cn(
                      "size-4",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.hint && (
                      <span className="truncate text-muted-foreground text-xs">
                        {option.hint}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ));
              return group.length > 0 ? (
                <CommandGroup heading={group} key={group}>
                  {items}
                </CommandGroup>
              ) : (
                <div key="ungrouped">{items}</div>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
