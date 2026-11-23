"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SaveAddressBookmark } from "@/components/address-book/save-address-bookmark";
import { Button } from "@/components/ui/button";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { AbiWithAutoFetchField } from "./abi-with-auto-fetch-field";

type EntryList<T extends { id: number }> = {
  entries: T[];
  addRow: () => void;
  removeRow: (targetId: number) => void;
  updateField: (
    targetId: number,
    key: keyof Omit<T, "id">,
    fieldValue: string
  ) => void;
};

/** Row state for a list builder field whose rows serialize to one config value. */
export function useEntryList<T extends { id: number }>(
  init: (nextId: () => number) => T[],
  serialize: (entries: T[]) => string,
  createEmpty: (id: number) => T,
  onChange: (value: string) => void
): EntryList<T> {
  const idCounter = useRef(0);
  const nextId = (): number => {
    idCounter.current += 1;
    return idCounter.current;
  };

  const [entries, setEntries] = useState<T[]>(() => init(nextId));

  // Notifies the parent from the committed `entries` state rather than
  // inline in each mutator. A field like AbiWithAutoFetchField's manual-ABI
  // toggle can call onUpdateConfig and onChange back to back in the same
  // handler; deriving each mutator's next array from a stale `entries`
  // closure would let the second call silently clobber the first. Reacting
  // to the committed state instead means every functional setEntries update
  // below composes correctly no matter how many fire in one event.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onChangeRef.current(serialize(entries));
  }, [entries, serialize]);

  function addRow(): void {
    setEntries((prev) => [...prev, createEmpty(nextId())]);
  }

  function removeRow(targetId: number): void {
    setEntries((prev) => {
      const updated = prev.filter((e) => e.id !== targetId);
      return updated.length > 0 ? updated : [createEmpty(nextId())];
    });
  }

  function updateField(
    targetId: number,
    key: keyof Omit<T, "id">,
    fieldValue: string
  ): void {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === targetId ? { ...entry, [key]: fieldValue } : entry
      )
    );
  }

  return { entries, addRow, removeRow, updateField };
}

type EntryCardProps = {
  title: string;
  disabled?: boolean;
  onRemove?: () => void;
  children: React.ReactNode;
};

export function EntryCard({
  title,
  disabled,
  onRemove,
  children,
}: EntryCardProps): React.ReactNode {
  return (
    <div className="rounded-md border border-border space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {title}
        </span>
        {onRemove && (
          <Button
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            disabled={disabled}
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

type AddEntryButtonProps = {
  label: string;
  disabled?: boolean;
  onClick: () => void;
};

export function AddEntryButton({
  label,
  disabled,
  onClick,
}: AddEntryButtonProps): React.ReactNode {
  return (
    <Button
      className="w-full"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant="outline"
    >
      <Plus className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

type ContractEntryKey = "contractAddress" | "abi" | "useManualAbi";

type EntryContractFieldsProps = {
  fieldKey: string;
  entryId: number;
  contractAddress: string;
  abi: string;
  useManualAbi: string;
  // Network the ABI is auto-fetched from.
  network: string;
  contractInteractionType?: "read" | "write";
  disabled?: boolean;
  onUpdate: (key: ContractEntryKey, value: string) => void;
};

/** Contract address and auto-fetched ABI inputs for one list row. */
export function EntryContractFields({
  fieldKey,
  entryId,
  contractAddress,
  abi,
  useManualAbi,
  network,
  contractInteractionType,
  disabled,
  onUpdate,
}: EntryContractFieldsProps): React.ReactNode {
  const rowConfig = useMemo<Record<string, unknown>>(
    () => ({ contractAddress, network, useManualAbi }),
    [contractAddress, network, useManualAbi]
  );

  return (
    <>
      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-addr-${entryId}`}
        >
          Contract Address
        </label>
        <SaveAddressBookmark address={contractAddress}>
          <TemplateBadgeInput
            disabled={disabled}
            id={`${fieldKey}-addr-${entryId}`}
            onChange={(val) => onUpdate("contractAddress", val)}
            placeholder="0x... or {{NodeName.address}}"
            value={contractAddress}
          />
        </SaveAddressBookmark>
      </div>

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-abi-${entryId}`}
        >
          ABI
        </label>
        <AbiWithAutoFetchField
          config={rowConfig}
          contractInteractionType={contractInteractionType}
          disabled={disabled}
          field={{
            key: `${fieldKey}-abi-${entryId}`,
            label: "ABI",
            type: "abi-with-auto-fetch",
          }}
          onChange={(val) => onUpdate("abi", String(val))}
          onUpdateConfig={(key, val) =>
            onUpdate(key as ContractEntryKey, String(val))
          }
          value={abi}
        />
      </div>
    </>
  );
}
