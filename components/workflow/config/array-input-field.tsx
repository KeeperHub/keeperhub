"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import type { AbiComponent } from "@/components/workflow/config/abi-types";
import { TupleInputField } from "@/components/workflow/config/tuple-input-field";
import {
  isWholeFieldTemplate,
  normalizeProtocolArrayValue,
} from "@/lib/protocol-array-value";

type ArrayItem = {
  id: number;
  value: unknown;
};

type ArrayInputFieldProps = {
  itemType: string;
  value: unknown;
  onChange: (value: unknown[]) => void;
  disabled?: boolean;
  fieldKey: string;
  components?: AbiComponent[];
};

function scalarItemText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function makeArrayItem(
  value: unknown,
  nextId: () => number,
  components?: AbiComponent[]
): ArrayItem {
  return {
    id: nextId(),
    value: components?.length ? (value ?? "") : scalarItemText(value),
  };
}

/**
 * Rows for one stored value, read through the shared protocol-array parse so
 * the editor, the validator and the steps agree on what a legacy value means.
 */
export function parseArrayValue(
  value: unknown,
  nextId: () => number,
  components?: AbiComponent[],
  itemType?: string
): ArrayItem[] {
  const solidityType = `${components?.length ? "tuple" : (itemType ?? "string")}[]`;
  const normalized = normalizeProtocolArrayValue(value, solidityType);

  if (Array.isArray(normalized)) {
    return normalized.map((item) => makeArrayItem(item, nextId, components));
  }
  // A whole-field reference stays a bare string; it edits as a single row.
  if (typeof normalized === "string" && normalized.trim() !== "") {
    return [makeArrayItem(normalized.trim(), nextId, components)];
  }
  return [];
}

function serializeItems(items: ArrayItem[]): unknown[] {
  return items.map((item) => item.value);
}

function haveEqualValues(current: ArrayItem[], incoming: ArrayItem[]): boolean {
  return (
    JSON.stringify(serializeItems(current)) ===
    JSON.stringify(serializeItems(incoming))
  );
}

function preserveRowIds(
  current: ArrayItem[],
  incoming: ArrayItem[]
): ArrayItem[] {
  if (haveEqualValues(current, incoming)) {
    return current;
  }

  return incoming.map((item, index) => ({
    ...item,
    id: current[index]?.id ?? item.id,
  }));
}

function makeEmptyValue(components?: AbiComponent[]): unknown {
  if (components && components.length > 0) {
    const obj: Record<string, unknown> = {};
    for (const comp of components) {
      obj[comp.name] = "";
    }
    return obj;
  }
  return "";
}

export function ArrayInputField({
  itemType,
  value,
  onChange,
  disabled,
  fieldKey,
  components,
}: ArrayInputFieldProps): React.ReactNode {
  const idCounter = useRef(0);
  const nextId = (): number => {
    idCounter.current += 1;
    return idCounter.current;
  };

  const [items, setItems] = useState<ArrayItem[]>(() =>
    parseArrayValue(value, nextId, components, itemType)
  );

  useEffect(() => {
    const incoming = parseArrayValue(value, nextId, components, itemType);
    setItems((current) => preserveRowIds(current, incoming));
  }, [components, itemType, value]);

  function updateItems(updated: ArrayItem[]): void {
    setItems(updated);
    onChange(serializeItems(updated));
  }

  function addItem(): void {
    updateItems([
      ...items,
      { id: nextId(), value: makeEmptyValue(components) },
    ]);
  }

  function removeItem(targetId: number): void {
    const updated = items.filter((item) => item.id !== targetId);
    updateItems(updated);
  }

  function updateItemValue(targetId: number, newValue: unknown): void {
    const updated = items.map((item) => {
      if (item.id !== targetId) {
        return item;
      }
      return { ...item, value: newValue };
    });
    updateItems(updated);
  }

  const isTuple = components !== undefined && components.length > 0;
  // A lone reference is stored bare and resolves to the whole array. A second
  // row turns the value into JSON with the resolved array inside one element,
  // which cannot encode.
  const holdsWholeFieldReference =
    items.length === 1 && isWholeFieldTemplate(items[0].value);

  return (
    <div className="space-y-1.5">
      {items.length === 0 && (
        <div className="rounded-md border border-dashed p-2 text-center text-muted-foreground text-xs">
          Empty array
        </div>
      )}
      {items.map((item, index) => (
        <div
          className={isTuple ? "space-y-1" : "flex items-center gap-1.5"}
          key={item.id}
        >
          {isTuple ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">
                  [{index}]
                </span>
                <Button
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={disabled}
                  onClick={() => removeItem(item.id)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              <TupleInputField
                components={components}
                disabled={disabled}
                fieldKey={`${fieldKey}-item-${item.id}`}
                onChange={(val) => updateItemValue(item.id, val)}
                value={item.value}
              />
            </>
          ) : (
            <>
              <span className="w-5 shrink-0 text-center text-muted-foreground text-xs">
                {index}
              </span>
              <div className="flex-1">
                <TemplateBadgeInput
                  disabled={disabled}
                  id={`${fieldKey}-item-${item.id}`}
                  onChange={(val) =>
                    updateItemValue(item.id, String(val))
                  }
                  placeholder={`Enter ${itemType} value or {{NodeName.value}}`}
                  value={typeof item.value === "string" ? item.value : ""}
                />
              </div>
              <Button
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                disabled={disabled}
                onClick={() => removeItem(item.id)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      ))}
      <Button
        className="w-full"
        disabled={disabled || holdsWholeFieldReference}
        onClick={addItem}
        size="sm"
        title={
          holdsWholeFieldReference
            ? "This reference already supplies the whole array. Remove it to list items individually."
            : undefined
        }
        type="button"
        variant="outline"
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {isTuple ? "Add Object" : "Add Item"}
      </Button>
      {holdsWholeFieldReference && (
        <p className="text-muted-foreground text-xs">
          This reference already supplies the whole array. Remove it to list
          items individually.
        </p>
      )}
    </div>
  );
}
