"use client";

import {
  AbiFunctionArgsField,
  AbiFunctionSelectField,
} from "@/components/workflow/config/action-config-renderer";
import type { ActionConfigFieldBase } from "@/plugins/registry";
import { ChainSelectField } from "./chain-select-field";
import {
  AddEntryButton,
  EntryCard,
  EntryContractFields,
  useEntryList,
} from "./entry-list";

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
  const { entries, addRow, removeRow, updateField } = useEntryList<CallEntry>(
    (nextId) => parseCallsValue(value, nextId),
    serializeCalls,
    createEmptyEntry,
    onChange
  );

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

      <AddEntryButton disabled={disabled} label="Add Call" onClick={addRow} />
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

  return (
    <EntryCard
      disabled={disabled}
      onRemove={onRemove}
      title={`Call ${index + 1}`}
    >
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

      <EntryContractFields
        abi={entry.abi}
        contractAddress={entry.contractAddress}
        contractInteractionType={contractInteractionType}
        disabled={disabled}
        entryId={entry.id}
        fieldKey={fieldKey}
        network={abiFetchNetwork}
        onUpdate={onUpdate}
        useManualAbi={entry.useManualAbi}
      />

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
    </EntryCard>
  );
}
