"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isValidAddress } from "@/lib/policy";
import { chainOptions, type ResourceSelection } from "@/lib/policy/ui";
import { useContractCatalog } from "../../hooks/use-contract-catalog";
import type { ContractEntries } from "../hooks/use-statement-builder";
import { usePolicyCatalog } from "../policy-context";
import { AddressField } from "./address-field";
import { ContractCombobox, CUSTOM_CONTRACT } from "./contract-combobox";
import { FieldLabel } from "./field-label";
import { FunctionPicker } from "./function-picker";
import { SearchableSelect } from "./searchable-select";

/**
 * Choose a contract, then choose functions on it.
 *
 * The order is a dependency chain rather than a wizard convention: the
 * function list is computed from the contract, so an incompatible pair never
 * exists to be selected.
 */
export function ResourcePicker({
  value,
  onChange,
  onContractLoaded,
}: {
  value: ResourceSelection;
  onChange: (next: ResourceSelection) => void;
  /** Lifts the resolved contract so capabilities derive from real functions. */
  onContractLoaded: (contract: ContractEntries) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();
  const contract = useContractCatalog();
  const [source, setSource] = useState<string>(CUSTOM_CONTRACT);

  const load = contract.load;
  useEffect(() => {
    if (value.chainId && isValidAddress(value.address)) {
      load(value.chainId, value.address, value.protocolSlug);
    }
  }, [value.chainId, value.address, value.protocolSlug, load]);

  const loaded = contract.catalog;
  useEffect(() => {
    if (!loaded) {
      return;
    }
    onContractLoaded({
      chainId: loaded.chainId,
      address: loaded.address,
      implementationAddress: loaded.implementationAddress,
      collisions: loaded.collisions,
      entries: loaded.groups.flatMap((group) => group.entries),
    });
  }, [loaded, onContractLoaded]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <FieldLabel
            hint="A rule matches only on the chain named here. The same protocol on another chain is a different contract and needs its own rule."
            htmlFor="resource-chain"
          >
            Chain
          </FieldLabel>
          <SearchableSelect
            id="resource-chain"
            onChange={(next) =>
              onChange({ ...value, chainId: Number(next), selectors: [] })
            }
            options={chainOptions(catalog)}
            placeholder="Select a chain"
            searchPlaceholder="Search chains"
            value={value.chainId ? String(value.chainId) : ""}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel
            hint="A known protocol deployment, which fills in the address for you. Choose the last option to name a contract the registry does not carry. Selecting a chain first narrows the list to that chain."
            htmlFor="resource-contract"
          >
            Contract
          </FieldLabel>
          <ContractCombobox
            chainId={value.chainId}
            chains={catalog.chains}
            onSelect={(option) => {
              setSource(option.key);
              onChange({
                ...value,
                chainId: option.chainId,
                address: option.address,
                protocolSlug: option.protocolSlug,
                selectors: [],
              });
            }}
            onSelectCustom={() => {
              setSource(CUSTOM_CONTRACT);
              onChange({
                ...value,
                address: "",
                protocolSlug: undefined,
                selectors: [],
              });
            }}
            protocols={catalog.protocols}
            value={source}
          />
        </div>
      </div>

      <AddressField
        hint="For an upgradeable protocol this is the proxy, because that is the address the transaction is sent to. The function list is read from its implementation, so the rule keeps working across upgrades."
        id="resource-address"
        label="Address"
        onChange={(address) => onChange({ ...value, address, selectors: [] })}
        value={value.address}
      />

      {contract.loading && (
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3" /> Reading the contract
        </p>
      )}

      {contract.error && (
        <Alert className="border-destructive/40 bg-destructive/5">
          <AlertDescription>{contract.error}</AlertDescription>
        </Alert>
      )}

      {contract.catalog?.isProxy && (
        <Alert>
          <AlertDescription>
            This is a proxy. The rule pins{" "}
            <span className="font-mono">{contract.catalog.address}</span>,
            because that is the address the transaction is sent to. The function
            list comes from its implementation at{" "}
            <span className="font-mono">
              {contract.catalog.implementationAddress}
            </span>
            , which can change without the rule needing an edit.
          </AlertDescription>
        </Alert>
      )}

      {contract.catalog && !contract.catalog.verified && (
        <Alert>
          <AlertDescription>
            This contract has no published ABI. The rule still applies, but
            nothing can check that a selector you enter exists.
          </AlertDescription>
        </Alert>
      )}

      {contract.catalog && (
        <FunctionPicker
          catalog={contract.catalog}
          onChange={(selectors) => onChange({ ...value, selectors })}
          onScopeChange={(selectorScope) =>
            onChange({ ...value, selectorScope })
          }
          scope={value.selectorScope}
          selected={value.selectors}
        />
      )}

      {!(contract.catalog || contract.loading) && (
        <Button
          disabled={!(value.chainId && isValidAddress(value.address))}
          onClick={() =>
            value.chainId &&
            contract.load(value.chainId, value.address, value.protocolSlug)
          }
          size="sm"
          variant="outline"
        >
          Read functions
        </Button>
      )}
    </div>
  );
}
