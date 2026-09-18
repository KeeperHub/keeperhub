"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isHashedIndexedType,
  isUnfilterableIndexedType,
} from "@/lib/web3/solidity-values";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type AbiEventInput = {
  name?: string;
  type?: string;
  indexed?: boolean;
};

type EventParam = {
  name: string;
  type: string;
  /** False for an indexed array or tuple, which no topic can match on. */
  filterable: boolean;
  /** True for indexed string and bytes, stored as a hash of the value. */
  hashed: boolean;
};

type AbiEventArgsFieldProps = {
  field: ActionConfigFieldBase;
  abiValue: string;
  eventValue: string;
  /** The stored filter: a JSON string from the editor, or an object from the API. */
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

/**
 * Why the panel has nothing to render.
 *
 * Kept apart from "the event genuinely has no indexed parameters", which is
 * a factual claim about the contract. Stating that while the ABI failed to
 * load would be confidently wrong.
 */
type ParamsState =
  | { kind: "ready"; params: EventParam[]; unnamed: number }
  | { kind: "no-event" }
  | { kind: "no-abi" }
  | { kind: "bad-abi" }
  | { kind: "event-missing" };

function parseIndexedParams(abiValue: string, eventName: string): ParamsState {
  if (!eventName) {
    return { kind: "no-event" };
  }
  if (!abiValue.trim()) {
    return { kind: "no-abi" };
  }
  let abi: unknown;
  try {
    abi = JSON.parse(abiValue);
  } catch {
    return { kind: "bad-abi" };
  }
  if (!Array.isArray(abi)) {
    return { kind: "bad-abi" };
  }
  const event = abi.find(
    (item: { type?: string; name?: string }) =>
      item?.type === "event" && item?.name === eventName
  ) as { inputs?: AbiEventInput[] } | undefined;
  if (!event) {
    return { kind: "event-missing" };
  }

  const indexed = (event.inputs ?? []).filter((input) => input.indexed);
  // An unnamed indexed parameter is dropped rather than given a positional
  // key: the filter is addressed by name, and the step would reject a
  // synthesised one. Counted so the panel can say so instead of pretending
  // the parameter is not there.
  return {
    kind: "ready",
    unnamed: indexed.filter((input) => !input.name).length,
    params: indexed
      .filter((input) => input.name)
      .map((input) => {
        const type = input.type ?? "";
        return {
          name: input.name ?? "",
          type,
          filterable: !isUnfilterableIndexedType(type),
          hashed: isHashedIndexedType(type),
        };
      }),
  };
}

type StoredFilter =
  | { kind: "ok"; filters: Record<string, string> }
  | { kind: "unreadable" };

function toFilterRecord(parsed: unknown): StoredFilter {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable" };
  }
  const filters: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(parsed)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      filters[key] = String(entry);
    } else {
      return { kind: "unreadable" };
    }
  }
  return { kind: "ok", filters };
}

/**
 * Read the stored filter without ever showing a value it does not hold.
 *
 * A value that does not parse is reported as unreadable rather than shown
 * as an empty filter: the step fails on it, and empty inputs would read as
 * "matching every value" while it does.
 */
function parseStored(raw: unknown): StoredFilter {
  if (raw === undefined || raw === null) {
    return { kind: "ok", filters: Object.create(null) };
  }
  if (typeof raw !== "string") {
    return toFilterRecord(raw);
  }
  if (!raw.trim()) {
    return { kind: "ok", filters: Object.create(null) };
  }
  try {
    return toFilterRecord(JSON.parse(raw));
  } catch {
    return { kind: "unreadable" };
  }
}

function placeholderFor(param: EventParam): string {
  if (param.type === "address") {
    return "0x... or {{NodeName.address}}";
  }
  if (param.type === "bool") {
    return "true or false";
  }
  if (param.type === "bytes") {
    // Hashed as bytes, so the value still has to be hex.
    return "0x... (matched in full)";
  }
  if (param.hashed) {
    return "exact value, matched in full";
  }
  if (param.type.startsWith("uint") || param.type.startsWith("int")) {
    return "whole number";
  }
  return `${param.type} value`;
}

export function AbiEventArgsField({
  field,
  abiValue,
  eventValue,
  value,
  onChange,
  disabled,
}: AbiEventArgsFieldProps) {
  const state = React.useMemo(
    () => parseIndexedParams(abiValue, eventValue),
    [abiValue, eventValue]
  );
  const parsedStored = React.useMemo(() => parseStored(value), [value]);
  const stored = React.useMemo<Record<string, string>>(
    () =>
      parsedStored.kind === "ok" ? parsedStored.filters : Object.create(null),
    [parsedStored]
  );

  // Only values belonging to the event now selected are shown or kept.
  // Switching Transfer to Approval otherwise leaves the old parameter in the
  // stored JSON, invisible in the panel, and the step fails on it at runtime.
  const allowed = React.useMemo(
    () =>
      new Set(
        state.kind === "ready"
          ? state.params.filter((p) => p.filterable).map((p) => p.name)
          : []
      ),
    [state]
  );
  const current = React.useMemo(() => {
    const kept: Record<string, string> = Object.create(null);
    for (const [key, entry] of Object.entries(stored)) {
      if (allowed.has(key)) {
        kept[key] = entry;
      }
    }
    return kept;
  }, [stored, allowed]);

  const staleKeys = Object.keys(stored).filter((key) => !allowed.has(key));

  React.useEffect(() => {
    // Prune only once the ABI and event have actually resolved, so a
    // half-loaded panel never clears a saved filter, and never for a viewer
    // who cannot edit: opening a node read-only must not rewrite it.
    if (disabled || state.kind !== "ready" || staleKeys.length === 0) {
      return;
    }
    onChange(
      Object.keys(current).length === 0 ? "" : JSON.stringify(current)
    );
  }, [disabled, state.kind, staleKeys.length, current, onChange]);

  const update = (name: string, next: string) => {
    const merged = { ...current };
    if (next.trim() === "") {
      delete merged[name];
    } else {
      merged[name] = next;
    }
    onChange(Object.keys(merged).length === 0 ? "" : JSON.stringify(merged));
  };

  // Checked first: the step fails on an unreadable value whatever the ABI
  // and event say, so no other message may stand in for this one.
  if (parsedStored.kind === "unreadable") {
    return (
      <div className="space-y-2 rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        <p>
          The saved filter is not a JSON object of parameter names to values,
          so it cannot be shown here. The step will fail on it until it is
          fixed or cleared.
        </p>
        {!disabled && (
          <Button onClick={() => onChange("")} size="sm" variant="outline">
            Clear filter
          </Button>
        )}
      </div>
    );
  }

  if (state.kind !== "ready") {
    const message = {
      "no-event": "Select an event to filter its indexed arguments",
      "no-abi": "Enter the contract ABI above to filter indexed arguments",
      "bad-abi": "The ABI above could not be read, so its parameters cannot be listed",
      "event-missing": `${eventValue} was not found in the ABI above`,
    }[state.kind];
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {message}
      </div>
    );
  }

  if (state.params.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {state.unnamed > 0
          ? `${eventValue} indexes ${state.unnamed} parameter(s) the ABI does not name, so they cannot be filtered by name`
          : `${eventValue} has no indexed parameters, so every occurrence is returned`}
      </div>
    );
  }

  const params = state.params;

  return (
    <div className="space-y-3" key={field.key}>
      {params.map((param) => (
        <div className="space-y-1" key={param.name}>
          <Label
            className="ml-1 font-normal text-xs"
            htmlFor={`${field.key}-${param.name}`}
          >
            {param.name}{" "}
            <span className="text-muted-foreground">{param.type}</span>
          </Label>
          <Input
            disabled={disabled || !param.filterable}
            id={`${field.key}-${param.name}`}
            onChange={(e) => update(param.name, e.target.value)}
            placeholder={
              param.filterable
                ? placeholderFor(param)
                : "Cannot be filtered at the RPC"
            }
            value={current[param.name] ?? ""}
          />
          {!param.filterable && (
            <p className="ml-1 text-muted-foreground text-xs">
              An indexed {param.type} is stored as a hash of its encoded
              contents, so there is no value to match on. Filter it in a later
              node instead.
            </p>
          )}
          {param.filterable && param.hashed && (
            <p className="ml-1 text-muted-foreground text-xs">
              An indexed {param.type} is stored as a hash, so this matches the
              whole value exactly. Partial matches are not possible, and the
              value cannot be read back from the log.
            </p>
          )}
        </div>
      ))}
      {state.unnamed > 0 && (
        <p className="ml-1 text-muted-foreground text-xs">
          {eventValue} also indexes {state.unnamed} parameter(s) the ABI does
          not name. Those cannot be filtered by name and always match any
          value.
        </p>
      )}
    </div>
  );
}
