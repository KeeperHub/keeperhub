"use client";

import type { ActionConfigFieldBase } from "@/plugins/registry";
import { AbiEventArgsField } from "./abi-event-args-field";
import { AbiEventSelectField } from "./abi-event-select-field";
import {
  AddEntryButton,
  EntryCard,
  EntryContractFields,
  useEntryList,
} from "./entry-list";

type EventEntry = {
  id: number;
  contractAddress: string;
  abi: string;
  eventName: string;
  // The filter as the panel writes it: empty, or a JSON object string.
  eventArgs: string;
  useManualAbi: string;
};

function createEmptyEntry(id: number): EventEntry {
  return {
    id,
    contractAddress: "",
    abi: "",
    eventName: "",
    eventArgs: "",
    useManualAbi: "false",
  };
}

function filterText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Reads the JSON string the editor stores or the array an API caller stores.
function parseEventsValue(value: unknown, nextId: () => number): EventEntry[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = value ? JSON.parse(value) : [];
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [createEmptyEntry(nextId())];
  }
  return parsed.map((item: unknown) => {
    const entry =
      item !== null && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {};
    return {
      id: nextId(),
      contractAddress: String(entry.contractAddress ?? ""),
      abi: String(entry.abi ?? ""),
      eventName: String(entry.eventName ?? ""),
      eventArgs: filterText(entry.eventArgs),
      useManualAbi: String(entry.useManualAbi ?? "false"),
    };
  });
}

function storedFilter(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Kept as written so the step reports it rather than the panel dropping it.
    return text;
  }
}

function serializeEvents(entries: EventEntry[]): string {
  // Empty rows are kept so an incomplete entry fails validation, not vanishes.
  const events = entries.map((e) => ({
    contractAddress: e.contractAddress,
    abi: e.abi,
    eventName: e.eventName,
    ...(e.eventArgs.trim() ? { eventArgs: storedFilter(e.eventArgs) } : {}),
    useManualAbi: e.useManualAbi,
  }));
  return JSON.stringify(events);
}

type EventListFieldProps = {
  field: ActionConfigFieldBase;
  value: unknown;
  onChange: (value: string) => void;
  disabled?: boolean;
  // Full action config, for the action-level network every entry runs on.
  actionConfig?: Record<string, unknown>;
};

export function EventListField({
  field,
  value,
  onChange,
  disabled,
  actionConfig,
}: EventListFieldProps): React.ReactNode {
  const { entries, addRow, removeRow, updateField } = useEntryList<EventEntry>(
    (nextId) => parseEventsValue(value, nextId),
    serializeEvents,
    createEmptyEntry,
    onChange
  );

  const network = String(
    actionConfig?.[field.networkField ?? "network"] ?? ""
  );

  return (
    <div className="space-y-3">
      {entries.map((entry, index) => (
        <EventRow
          contractInteractionType={field.contractInteractionType}
          disabled={disabled}
          entry={entry}
          fieldKey={field.key}
          index={index}
          key={entry.id}
          network={network}
          onRemove={entries.length > 1 ? () => removeRow(entry.id) : undefined}
          onUpdate={(key, val) => updateField(entry.id, key, val)}
        />
      ))}

      <AddEntryButton disabled={disabled} label="Add Event" onClick={addRow} />
    </div>
  );
}

type EventRowProps = {
  entry: EventEntry;
  index: number;
  fieldKey: string;
  network: string;
  disabled?: boolean;
  contractInteractionType?: "read" | "write";
  onUpdate: (key: keyof Omit<EventEntry, "id">, value: string) => void;
  onRemove?: () => void;
};

function EventRow({
  entry,
  index,
  fieldKey,
  network,
  disabled,
  contractInteractionType,
  onUpdate,
  onRemove,
}: EventRowProps): React.ReactNode {
  return (
    <EntryCard
      disabled={disabled}
      onRemove={onRemove}
      title={`Event ${index + 1}`}
    >
      <EntryContractFields
        abi={entry.abi}
        contractAddress={entry.contractAddress}
        contractInteractionType={contractInteractionType}
        disabled={disabled}
        entryId={entry.id}
        fieldKey={fieldKey}
        network={network}
        onUpdate={onUpdate}
        useManualAbi={entry.useManualAbi}
      />

      <div className="space-y-1.5">
        <label
          className="text-xs font-medium"
          htmlFor={`${fieldKey}-event-${entry.id}`}
        >
          Event
        </label>
        <AbiEventSelectField
          abiValue={entry.abi}
          disabled={disabled}
          field={{
            key: `${fieldKey}-event-${entry.id}`,
            label: "Event",
            type: "abi-event-select",
            placeholder: "Select an event",
          }}
          onChange={(val) => onUpdate("eventName", String(val))}
          value={entry.eventName}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Filter by Indexed Arguments</p>
        <AbiEventArgsField
          abiValue={entry.abi}
          disabled={disabled}
          eventValue={entry.eventName}
          field={{
            key: `${fieldKey}-args-${entry.id}`,
            label: "Filter by Indexed Arguments",
            type: "abi-event-args",
          }}
          onChange={(val) => onUpdate("eventArgs", filterText(val))}
          value={entry.eventArgs}
        />
      </div>
    </EntryCard>
  );
}
