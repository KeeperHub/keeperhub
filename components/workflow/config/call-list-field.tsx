"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import {
  AbiFunctionArgsField,
  AbiFunctionSelectField,
} from "@/components/workflow/config/action-config-renderer";

import { SaveAddressBookmark } from "@/components/address-book/save-address-bookmark";
import type { ActionConfigFieldBase } from "@/plugins/registry";
import { AbiWithAutoFetchField } from "./abi-with-auto-fetch-field";
import { ChainSelectField } from "./chain-select-field";

type CallEntry = {
  id: number;
  network: string;
  contractAddress: string;
  abi: string;
  abiFunction: string;
  args: string;
};

function createEmptyEntry(id: number): CallEntry {
  return {
    id,
    network: "",
    contractAddress: "",
    abi: "",
    abiFunction: "",
    args: "",
  };
}

function parseCallsValue(value: string, nextId: () => number): CallEntry[] {
  if (!value) {
    return [createEmptyEntry(nextId())];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [createEmptyEntry(nextId())];
    }
    return parsed.map((item: Record<string, unknown>) => ({
      id: nextId(),
      network: String(item.network ?? ""),
      contractAddress: String(item.contractAddress ?? ""),
      abi: String(item.abi ?? ""),
      abiFunction: String(item.abiFunction ?? ""),
      args: Array.isArray(item.args) ? JSON.stringify(item.args) : "",
    }));
  } catch {
    return [createEmptyEntry(nextId())];
  }
}

function serializeCalls(entries: CallEntry[]): string {
  const calls = entries
    .filter((e) => e.contractAddress.trim() || e.abiFunction.trim())
    .map((e) => {
      let args: unknown[] = [];
      if (e.args.trim()) {
        try {
          const parsed: unknown = JSON.parse(e.args);
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          args = [e.args];
        }
      }
      return {
        network: e.network,
        contractAddress: e.contractAddress,
        abi: e.abi,
        abiFunction: e.abiFunction,
        args,
      };
    });
  return calls.length > 0 ? JSON.stringify(calls) : "";
}

type CallListFieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function CallListField({
  field,
  value,
  onChange,
  disabled,
}: CallListFieldProps): React.ReactNode {
  const idCounter = useRef(0);
  const nextId = (): number => {
    idCounter.current += 1;
    return idCounter.current;
  };

  const [entries, setEntries] = useState<CallEntry[]>(() =>
    parseCallsValue(value, nextId)
  );

  function updateEntries(updated: CallEntry[]): void {
    setEntries(updated);
    onChange(serializeCalls(updated));
  }

  function addRow(): void {
    updateEntries([...entries, createEmptyEntry(nextId())]);
  }

  function removeRow(targetId: number): void {
    const updated = entries.filter((e) => e.id !== targetId);
    updateEntries(updated.length > 0 ? updated : [createEmptyEntry(nextId())]);
  }

  function updateField(
    targetId: number,
    key: keyof Omit<CallEntry, "id">,
    fieldValue: string
  ): void {
    const updated = entries.map((entry) =>
      entry.id === targetId ? { ...entry, [key]: fieldValue } : entry
    );
    updateEntries(updated);
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, index) => (
        <CallRow
          disabled={disabled}
          entry={entry}
          fieldKey={field.key}
          index={index}
          key={entry.id}
          onRemove={entries.length > 1 ? () => removeRow(entry.id) : undefined}
          onUpdate={(key, val) => updateField(entry.id, key, val)}
        />
      ))}

      <Button
        className="w-full"
        disabled={disabled}
        onClick={addRow}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add Call
      </Button>
    </div>
  );
}

type CallRowProps = {
  entry: CallEntry;
  index: number;
  fieldKey: string;
  disabled?: boolean;
  onUpdate: (key: keyof Omit<CallEntry, "id">, value: string) => void;
  onRemove?: () => void;
};

function CallRow({
  entry,
  index,
  fieldKey,
  disabled,
  onUpdate,
  onRemove,
}: CallRowProps): React.ReactNode {
  const rowConfig = useMemo<Record<string, unknown>>(
    () => ({
      contractAddress: entry.contractAddress,
      network: entry.network,
    }),
    [entry.contractAddress, entry.network]
  );

  return (
    <div className="rounded-md border border-border space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Call {index + 1}
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

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-net-${entry.id}`}
        >
          Network
        </label>
        <ChainSelectField
          chainTypeFilter="evm"
          disabled={disabled}
          field={{
            key: `${fieldKey}-net-${entry.id}`,
            label: "Network",
            type: "chain-select",
          }}
          onChange={(val) => onUpdate("network", String(val))}
          value={entry.network}
        />
      </div>

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-addr-${entry.id}`}
        >
          Contract Address
        </label>
        <SaveAddressBookmark address={entry.contractAddress}>
          <TemplateBadgeInput
            disabled={disabled}
            id={`${fieldKey}-addr-${entry.id}`}
            onChange={(val) => onUpdate("contractAddress", val)}
            placeholder="0x... or {{NodeName.address}}"
            value={entry.contractAddress}
          />
        </SaveAddressBookmark>
      </div>

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-abi-${entry.id}`}
        >
          ABI
        </label>
        <AbiWithAutoFetchField
          config={rowConfig}
          contractInteractionType="read"
          disabled={disabled}
          field={{
            key: `${fieldKey}-abi-${entry.id}`,
            label: "ABI",
            type: "abi-with-auto-fetch",
          }}
          onChange={(val) => onUpdate("abi", String(val))}
          value={entry.abi}
        />
      </div>

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-fn-${entry.id}`}
        >
          Function
        </label>
        <AbiFunctionSelectField
          abiValue={entry.abi}
          disabled={disabled}
          field={{
            key: `${fieldKey}-fn-${entry.id}`,
            label: "Function",
            type: "abi-function-select",
            placeholder: "Select a function",
          }}
          functionFilter="read"
          onChange={(val) => onUpdate("abiFunction", String(val))}
          value={entry.abiFunction}
        />
      </div>

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-args-${entry.id}`}
        >
          Function Arguments
        </label>
        <AbiFunctionArgsField
          abiValue={entry.abi}
          disabled={disabled}
          field={{
            key: `${fieldKey}-args-${entry.id}`,
            label: "Function Arguments",
            type: "abi-function-args",
          }}
          functionValue={entry.abiFunction}
          onChange={(val) => onUpdate("args", String(val))}
          value={entry.args}
        />
      </div>
    </div>
  );
}
