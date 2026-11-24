"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { CounterpartyScope } from "@/lib/policy/ui";
import { usePolicyCatalog } from "../policy-context";
import { FieldLabel } from "./field-label";
import { SearchableSelect } from "./searchable-select";

const SCOPE_OPTIONS = [
  {
    value: CounterpartyScope.ANY,
    label: "Any counterparty",
    hint: "The rule places no restriction on who receives or spends",
  },
  {
    value: CounterpartyScope.ONLY,
    label: "Only these",
    hint: "Anything else is refused",
  },
  {
    value: CounterpartyScope.EXCEPT,
    label: "Anything except these",
    hint: "An exception: everything else is permitted",
  },
];

/**
 * Which counterparties a rule covers.
 *
 * The mode is chosen rather than inferred. A list of ticked boxes where
 * unticked means "no restriction" reads as a list of exclusions and behaves as
 * a list of permissions, and nothing on screen says which was meant.
 */
export function CounterpartyPicker({
  index,
  scope,
  selected,
  onScopeChange,
  onSelectedChange,
}: {
  index: number;
  scope: CounterpartyScope;
  selected: readonly string[];
  onScopeChange: (next: CounterpartyScope) => void;
  onSelectedChange: (next: string[]) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();

  const changeScope = (next: string): void => {
    onScopeChange(next as CounterpartyScope);
    if (next === CounterpartyScope.ANY) {
      onSelectedChange([]);
    }
  };

  const toggle = (address: string): void => {
    onSelectedChange(
      selected.includes(address)
        ? selected.filter((value) => value !== address)
        : [...selected, address]
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <FieldLabel
          hint="Who the funds may reach, or may not. An exception permits everything else, so it bounds a known-bad address rather than describing what is allowed."
          htmlFor={`counterparty-scope-${index}`}
        >
          Counterparties
        </FieldLabel>
        <SearchableSelect
          id={`counterparty-scope-${index}`}
          onChange={changeScope}
          options={SCOPE_OPTIONS}
          value={scope}
        />
      </div>

      {scope === CounterpartyScope.EXCEPT && (
        <p className="text-muted-foreground text-xs">
          A refusal cannot be reopened by another policy, so an address excepted
          here stays refused even where a different policy permits it. To carve
          out one function, add that condition to this rule rather than writing
          a second rule beside it.
        </p>
      )}

      {scope !== CounterpartyScope.ANY && (
        <div className="flex flex-col gap-1">
          {catalog.counterparties.map((entry) => (
            <div
              className="flex items-center gap-2 text-xs"
              key={entry.address}
            >
              <Checkbox
                checked={selected.includes(entry.address)}
                id={`cp-${index}-${entry.address}`}
                onCheckedChange={() => toggle(entry.address)}
              />
              <label htmlFor={`cp-${index}-${entry.address}`}>
                {entry.label}
              </label>
              <span className="font-mono text-muted-foreground">
                {entry.address}
              </span>
            </div>
          ))}
          {catalog.counterparties.length === 0 && (
            <p className="text-muted-foreground text-xs">
              The address book is empty, so there is nothing to name yet. Add an
              entry there first.
            </p>
          )}
          {selected.length === 0 && catalog.counterparties.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Nothing is ticked, so this rule places no counterparty restriction
              yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
