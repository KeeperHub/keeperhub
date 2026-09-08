"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  useManualAbi: string;
};

function createEmptyEntry(id: number): CallEntry {
  return {
    id,
    network: "",
    contractAddress: "",
    abi: "",
    abiFunction: "",
    args: "",
    useManualAbi: "false",
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
      useManualAbi: String(item.useManualAbi ?? "false"),
    }));
  } catch {
    return [createEmptyEntry(nextId())];
  }
}

function serializeCalls(entries: CallEntry[]): string {
  // Every row the user has added is persisted as-is, including an empty one:
  // dropping "blank" rows here lets an incomplete call silently vanish from
  // the saved config instead of being caught as having a missing required
  // field (contractAddress/abi/abiFunction), which lets a batch run with
  // fewer calls than the UI shows.
  const calls = entries.map((e) => {
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
      useManualAbi: e.useManualAbi,
    };
  });
  return JSON.stringify(calls);
}

type CallListFieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  // Full action config, used to read the action-level network when this
  // field's per-row Network selector is hidden (see hideNetworkColumn).
  actionConfig?: Record<string, unknown>;
};

export function CallListField({
  field,
  value,
  onChange,
  disabled,
  actionConfig,
}: CallListFieldProps): React.ReactNode {
  const idCounter = useRef(0);
  const nextId = (): number => {
    idCounter.current += 1;
    return idCounter.current;
  };

  const [entries, setEntries] = useState<CallEntry[]>(() =>
    parseCallsValue(value, nextId)
  );

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
    onChangeRef.current(serializeCalls(entries));
  }, [entries]);

  function addRow(): void {
    setEntries((prev) => [...prev, createEmptyEntry(nextId())]);
  }

  function removeRow(targetId: number): void {
    setEntries((prev) => {
      const updated = prev.filter((e) => e.id !== targetId);
      return updated.length > 0 ? updated : [createEmptyEntry(nextId())];
    });
  }

  function updateField(
    targetId: number,
    key: keyof Omit<CallEntry, "id">,
    fieldValue: string
  ): void {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === targetId ? { ...entry, [key]: fieldValue } : entry
      )
    );
  }

  const actionNetwork = String(
    actionConfig?.[field.networkField ?? "network"] ?? ""
  );

  return (
    <div className="space-y-3">
      {entries.map((entry, index) => (
        <CallRow
          actionNetwork={actionNetwork}
          contractInteractionType={field.contractInteractionType}
          disabled={disabled}
          entry={entry}
          fieldKey={field.key}
          functionFilter={field.functionFilter}
          hideNetworkColumn={field.hideNetworkColumn}
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
  functionFilter?: "read" | "write";
  contractInteractionType?: "read" | "write";
  hideNetworkColumn?: boolean;
  // Action-level network, used for ABI auto-fetch when the per-row Network
  // selector is hidden (hideNetworkColumn).
  actionNetwork?: string;
  onUpdate: (key: keyof Omit<CallEntry, "id">, value: string) => void;
  onRemove?: () => void;
};

function CallRow({
  entry,
  index,
  fieldKey,
  disabled,
  functionFilter,
  contractInteractionType,
  hideNetworkColumn,
  actionNetwork,
  onUpdate,
  onRemove,
}: CallRowProps): React.ReactNode {
  const abiFetchNetwork = hideNetworkColumn
    ? (actionNetwork ?? "")
    : entry.network;

  const rowConfig = useMemo<Record<string, unknown>>(
    () => ({
      contractAddress: entry.contractAddress,
      network: abiFetchNetwork,
      useManualAbi: entry.useManualAbi,
    }),
    [entry.contractAddress, abiFetchNetwork, entry.useManualAbi]
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

      {!hideNetworkColumn && (
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
      )}

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
          contractInteractionType={contractInteractionType}
          disabled={disabled}
          field={{
            key: `${fieldKey}-abi-${entry.id}`,
            label: "ABI",
            type: "abi-with-auto-fetch",
          }}
          onChange={(val) => onUpdate("abi", String(val))}
          onUpdateConfig={(key, val) =>
            onUpdate(key as keyof Omit<CallEntry, "id">, String(val))
          }
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
          functionFilter={functionFilter}
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
