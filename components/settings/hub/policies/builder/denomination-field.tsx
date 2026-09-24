"use client";

import { Input } from "@/components/ui/input";
import { denominationOptions } from "@/lib/policy/ui";
import { usePolicyCatalog } from "../policy-context";
import { FieldLabel } from "./field-label";
import { SearchableSelect } from "./searchable-select";

/**
 * An amount, and what it is counted in.
 *
 * Dollars span assets and chains but put a price oracle in the decision path.
 * Denominating in a token removes the oracle, which is what a rule like "at
 * most 100k USDC a day" actually means, as distinct from "at most $100k of
 * whatever this is worth today".
 */
export function DenominationField({
  id,
  label,
  hint,
  amount,
  denomination,
  chainId,
  placeholder,
  onAmountChange,
  onDenominationChange,
}: {
  id: string;
  label: string;
  hint: string;
  amount: string;
  denomination: string;
  /** Restricts the token list to one chain. Null offers every chain, grouped. */
  chainId: number | null;
  placeholder?: string;
  onAmountChange: (next: string) => void;
  onDenominationChange: (next: string) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();
  const options = denominationOptions(catalog, chainId);

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel hint={hint} htmlFor={id}>
        {label}
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          className="flex-1"
          id={id}
          inputMode="decimal"
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder={placeholder}
          value={amount}
        />
        <SearchableSelect
          className="w-48"
          id={`${id}-denomination`}
          onChange={onDenominationChange}
          options={options}
          searchPlaceholder="Search tokens"
          value={denomination}
        />
      </div>
      {chainId === null && (
        <p className="text-muted-foreground text-xs">
          No chain is selected, so tokens from every chain are listed. Choose a
          chain to narrow them, or pick an option under Any asset.
        </p>
      )}
    </div>
  );
}
