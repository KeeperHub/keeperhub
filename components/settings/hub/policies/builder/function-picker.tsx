"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { SelectorCatalogEntry } from "@/lib/policy/catalog/types";
import { SelectorScope } from "@/lib/policy/ui";
import type { ContractCatalogResponse } from "../../hooks/use-contract-catalog";
import { RiskBadge } from "./risk-badge";
import { SearchableSelect } from "./searchable-select";

const SCOPE_OPTIONS = [
  {
    value: SelectorScope.THESE,
    label: "These functions",
    hint: "The rule covers only what is ticked",
  },
  {
    value: SelectorScope.EXCEPT,
    label: "Every function except these",
    hint: "The rule covers the whole contract, minus what is ticked",
  },
];

function matchesQuery(entry: SelectorCatalogEntry, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const needle = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.signature.toLowerCase().includes(needle) ||
    entry.selector.includes(needle)
  );
}

function FunctionRow({
  entry,
  selected,
  isCollision,
  onToggle,
}: {
  entry: SelectorCatalogEntry;
  selected: boolean;
  isCollision: boolean;
  onToggle: (selector: string) => void;
}): React.ReactElement {
  return (
    // The whole row is the target. A checkbox is a small thing to hit, and a
    // row that responds to a click only on its box gives no sign that the rest
    // of it is inert.
    <button
      aria-pressed={selected}
      className="flex w-full items-start gap-2 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onToggle(entry.selector)}
      type="button"
    >
      <Checkbox
        aria-hidden
        checked={selected}
        className="pointer-events-none mt-0.5"
        tabIndex={-1}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <span className="truncate">{entry.signature}</span>
          <span className="text-muted-foreground">{entry.selector}</span>
          {entry.isDispatcher && (
            <Badge variant="destructive">Forwards any call</Badge>
          )}
          {isCollision && <Badge variant="outline">Shared selector</Badge>}
        </div>
        {entry.conditionKeys.length > 0 && (
          <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
            Can bind: {entry.conditionKeys.join(", ")}
          </p>
        )}
      </div>
    </button>
  );
}

/**
 * Pick functions, grouped by risk class rather than alphabetically.
 *
 * The grouping is the point: "everything under Position management" is a
 * reasonable rule to write, "everything under Access control" almost never is,
 * and the order makes that visible before any signature is read.
 */
export function FunctionPicker({
  catalog,
  selected,
  scope,
  onChange,
  onScopeChange,
}: {
  catalog: ContractCatalogResponse;
  selected: readonly string[];
  /** Whether the ticked functions are covered, or carved out of the rule. */
  scope: SelectorScope;
  onChange: (selectors: string[]) => void;
  onScopeChange: (next: SelectorScope) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const groups = useMemo(
    () =>
      catalog.groups
        .map((group) => ({
          ...group,
          entries: group.entries.filter((entry) => matchesQuery(entry, query)),
        }))
        .filter((group) => group.entries.length > 0),
    [catalog.groups, query]
  );

  const toggle = (selector: string): void => {
    const next = new Set(selectedSet);
    if (next.has(selector)) {
      next.delete(selector);
    } else {
      next.add(selector);
    }
    onChange([...next]);
  };

  const toggleGroup = (entries: SelectorCatalogEntry[]): void => {
    const all = entries.every((entry) => selectedSet.has(entry.selector));
    const next = new Set(selectedSet);
    for (const entry of entries) {
      if (all) {
        next.delete(entry.selector);
      } else {
        next.add(entry.selector);
      }
    }
    onChange([...next]);
  };

  return (
    <div className="flex flex-col gap-3">
      <SearchableSelect
        id="function-scope"
        onChange={(next) => onScopeChange(next as SelectorScope)}
        options={SCOPE_OPTIONS}
        value={scope}
      />

      {scope === SelectorScope.EXCEPT && (
        <p className="text-muted-foreground text-xs">
          The rule covers the whole contract, with the ticked functions taken
          out of it. On a refusal that is how one function is carved out: a
          permission written beside the refusal would not reopen it.
        </p>
      )}

      {catalog.verified ? null : (
        <p className="text-muted-foreground text-xs">
          Nothing describes this contract: it is not one of the protocols this
          platform ships, and the block explorer has no verified source for it.
          Leave the rule open to cover the whole contract, or name a selector in
          the document directly.
        </p>
      )}

      {catalog.verified && (
        <Input
          aria-label="Search functions"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, signature, or selector"
          value={query}
        />
      )}

      {groups.length === 0 && (
        <p className="text-muted-foreground text-xs">
          No function matches that search.
        </p>
      )}

      {groups.map((group) => {
        const allSelected = group.entries.every((entry) =>
          selectedSet.has(entry.selector)
        );
        return (
          <div
            className="rounded-md border border-border p-3"
            key={group.riskClass}
          >
            <button
              aria-pressed={allSelected}
              className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => toggleGroup(group.entries)}
              type="button"
            >
              <Checkbox
                aria-hidden
                checked={allSelected}
                className="pointer-events-none"
                tabIndex={-1}
              />
              <RiskBadge riskClass={group.riskClass} />
              <span className="text-muted-foreground text-xs">
                {group.entries.length}
              </span>
              <span className="ml-auto text-muted-foreground text-xs">
                {allSelected ? "Clear all" : "Select all"}
              </span>
            </button>
            {/* No dividers: each row already reads as its own target through
                its hover background, and a rule between rows cuts across that
                background rather than separating anything. */}
            <div className="mt-2 flex flex-col gap-0.5">
              {group.entries.map((entry) => (
                <FunctionRow
                  entry={entry}
                  isCollision={catalog.collisions.includes(entry.selector)}
                  key={entry.selector}
                  onToggle={toggle}
                  selected={selectedSet.has(entry.selector)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
