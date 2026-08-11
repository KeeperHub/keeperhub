"use client";

import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type FieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

type AbiEventSelectProps = FieldProps & {
  abiValue: string;
};

export function AbiEventSelectField({
  field,
  value,
  onChange,
  disabled,
  abiValue,
}: AbiEventSelectProps) {
  // Parse ABI and extract events
  const events = React.useMemo(() => {
    if (!abiValue || abiValue.trim() === "") {
      return [];
    }

    try {
      const abi = JSON.parse(abiValue);
      if (!Array.isArray(abi)) {
        return [];
      }

      // Filter for events only (type === "event")
      return abi
        .filter((item: { type: string }) => item.type === "event")
        .map((event) => {
          const inputs = event.inputs || [];
          const params = inputs
            .map((input: { name: string; type: string; indexed?: boolean }) => {
              const indexed = input.indexed ? " indexed" : "";
              return `${input.type}${indexed} ${input.name || "unnamed"}`;
            })
            .join(", ");
          return {
            name: event.name,
            label: `${event.name}(${params})`,
          };
        });
    } catch {
      return [];
    }
  }, [abiValue]);

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {abiValue
          ? "No events found in ABI"
          : "Enter ABI above to see available events"}
      </div>
    );
  }

  return (
    <Select disabled={disabled} onValueChange={onChange} value={value}>
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={field.placeholder || "Select an event"} />
      </SelectTrigger>
      <SelectContent>
        {events.map((event) => (
          <SelectItem key={event.name} value={event.name}>
            <div className="flex flex-col items-start">
              <span>{event.label}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
