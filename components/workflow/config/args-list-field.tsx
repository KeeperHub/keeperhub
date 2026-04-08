"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import type { AbiComponent } from "@/components/workflow/config/abi-types";
import { ArrayInputField } from "@/components/workflow/config/array-input-field";
import { TupleInputField } from "@/components/workflow/config/tuple-input-field";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type FunctionInput = {
  name: string;
  type: string;
  components?: AbiComponent[];
};

type ArgSetEntry = {
  id: number;
  values: unknown[];
};

export function parseFunctionInputs(
  abiValue: string,
  functionValue: string
): FunctionInput[] {
  if (!(abiValue && functionValue && abiValue.trim() && functionValue.trim())) {
    return [];
  }

  try {
    const abi: unknown = JSON.parse(abiValue);
    if (!Array.isArray(abi)) {
      return [];
    }

    const func = abi.find(
      (item: Record<string, unknown>) =>
        item.type === "function" && item.name === functionValue
    );

    if (!(func?.inputs && Array.isArray(func.inputs))) {
      return [];
    }

    return func.inputs.map(
      (input: { name: string; type: string; components?: AbiComponent[] }) => ({
        name: input.name || "unnamed",
        type: input.type,
        components: input.components,
      })
    );
  } catch {
    return [];
  }
}

export function parseArgsListValue(
  value: string,
  paramCount: number,
  nextId: () => number
): ArgSetEntry[] {
  if (!value) {
    return [{ id: nextId(), values: new Array(paramCount).fill("") }];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [{ id: nextId(), values: new Array(paramCount).fill("") }];
    }

    return parsed.map((argSet: unknown) => {
      const arr = Array.isArray(argSet) ? argSet : [];
      const values: unknown[] = [];
      for (let i = 0; i < paramCount; i++) {
        const item = arr[i];
        if (Array.isArray(item)) {
          values.push(item);
        } else if (item !== undefined && item !== null) {
          values.push(String(item));
        } else {
          values.push("");
        }
      }
      return { id: nextId(), values };
    });
  } catch {
    return [{ id: nextId(), values: new Array(paramCount).fill("") }];
  }
}

export function serializeArgsList(entries: ArgSetEntry[]): string {
  const sets = entries
    .filter((e) =>
      e.values.some((v) => {
        if (typeof v === "string") {
          return v.trim() !== "";
        }
        if (Array.isArray(v)) {
          return v.length > 0;
        }
        return typeof v === "object" && v !== null;
      })
    )
    .map((e) => e.values);
  return sets.length > 0 ? JSON.stringify(sets) : "";
}

type ArgsListFieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  abiValue: string;
  functionValue: string;
};

export function ArgsListField({
  field,
  value,
  onChange,
  disabled,
  abiValue,
  functionValue,
}: ArgsListFieldProps): React.ReactNode {
  const idCounter = useRef(0);
  const nextId = (): number => {
    idCounter.current += 1;
    return idCounter.current;
  };

  const functionInputs = useMemo(
    () => parseFunctionInputs(abiValue, functionValue),
    [abiValue, functionValue]
  );

  const paramCount = functionInputs.length;

  const [entries, setEntries] = useState<ArgSetEntry[]>(() =>
    parseArgsListValue(value, paramCount, nextId)
  );

  // Reset entries when function changes
  const lastFunctionRef = useRef(functionValue);
  if (functionValue !== lastFunctionRef.current) {
    lastFunctionRef.current = functionValue;
    const newEntries = parseArgsListValue("", paramCount, nextId);
    setEntries(newEntries);
    onChange("");
  }

  function updateEntries(updated: ArgSetEntry[]): void {
    setEntries(updated);
    onChange(serializeArgsList(updated));
  }

  function addRow(): void {
    updateEntries([
      ...entries,
      { id: nextId(), values: new Array(paramCount).fill("") },
    ]);
  }

  function removeRow(targetId: number): void {
    const updated = entries.filter((e) => e.id !== targetId);
    updateEntries(
      updated.length > 0
        ? updated
        : [{ id: nextId(), values: new Array(paramCount).fill("") }]
    );
  }

  function updateArgValue(
    targetId: number,
    argIndex: number,
    argValue: unknown
  ): void {
    const updated = entries.map((entry) => {
      if (entry.id !== targetId) {
        return entry;
      }
      const newValues = [...entry.values];
      newValues[argIndex] = argValue;
      return { ...entry, values: newValues };
    });
    updateEntries(updated);
  }

  if (paramCount === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {functionValue
          ? "This function has no parameters"
          : "Select a function above to configure arguments"}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, index) => (
        <div
          className="rounded-md border border-border space-y-2 p-3"
          key={entry.id}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Call {index + 1}
            </span>
            {entries.length > 1 && (
              <Button
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                disabled={disabled}
                onClick={() => removeRow(entry.id)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {functionInputs.map((input, argIndex) => {
            const isArray = input.type.endsWith("[]");
            const baseType = isArray ? input.type.slice(0, -2) : input.type;
            const hasTupleComponents =
              input.components !== undefined && input.components.length > 0;
            const isTuple = baseType === "tuple" && hasTupleComponents;

            return (
              <div
                className="space-y-1.5"
                key={`${field.key}-${entry.id}-arg-${argIndex}`}
              >
                <label
                  className="text-xs font-medium"
                  htmlFor={`${field.key}-${entry.id}-${argIndex}`}
                >
                  {input.name}{" "}
                  <span className="text-muted-foreground">({input.type})</span>
                </label>
                {isArray ? (
                  <ArrayInputField
                    components={isTuple ? input.components : undefined}
                    disabled={disabled}
                    fieldKey={`${field.key}-${entry.id}-${argIndex}`}
                    itemType={baseType}
                    onChange={(val) =>
                      updateArgValue(entry.id, argIndex, val)
                    }
                    value={entry.values[argIndex]}
                  />
                ) : isTuple ? (
                  <TupleInputField
                    components={input.components ?? []}
                    disabled={disabled}
                    fieldKey={`${field.key}-${entry.id}-${argIndex}`}
                    onChange={(val) =>
                      updateArgValue(entry.id, argIndex, val)
                    }
                    value={entry.values[argIndex]}
                  />
                ) : (
                  <TemplateBadgeInput
                    disabled={disabled}
                    id={`${field.key}-${entry.id}-${argIndex}`}
                    onChange={(val) =>
                      updateArgValue(entry.id, argIndex, String(val))
                    }
                    placeholder={`Enter ${input.type} value or {{NodeName.value}}`}
                    value={(entry.values[argIndex] as string) ?? ""}
                  />
                )}
              </div>
            );
          })}
        </div>
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
        Add Arg Set
      </Button>
    </div>
  );
}
