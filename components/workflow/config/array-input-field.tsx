"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import type { AbiComponent } from "@/components/workflow/config/abi-types";
import { TupleInputField } from "@/components/workflow/config/tuple-input-field";

type ArrayItem = {
  id: number;
  value: unknown;
};

type ParsedArrayValue = {
  items: ArrayItem[];
  shouldMigrateLegacyValue: boolean;
};

type ArrayInputFieldProps = {
  itemType: string;
  value: unknown;
  onChange: (value: unknown[]) => void;
  disabled?: boolean;
  fieldKey: string;
  components?: AbiComponent[];
};

function isTemplateValue(value: string): boolean {
  return /^\{\{.+\}\}$/.test(value.trim());
}

function parseArrayValueWithMigration(
  value: unknown,
  nextId: () => number
): ParsedArrayValue {
  if (Array.isArray(value) && value.length > 0) {
    return {
      items: value.map((v) => ({
        id: nextId(),
        value: v ?? "",
      })),
      shouldMigrateLegacyValue: false,
    };
  }

  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          items: parsed.map((v) => ({
            id: nextId(),
            value: v ?? "",
          })),
          shouldMigrateLegacyValue: false,
        };
      }

      return { items: [], shouldMigrateLegacyValue: false };
    } catch {
      if (isTemplateValue(value)) {
        return { items: [], shouldMigrateLegacyValue: false };
      }

      // Before scalar arrays had a structured editor, protocol inputs such as
      // Aerodrome gauge lists were entered as comma-separated text. Preserve
      // those saved values when the workflow is opened in the new editor.
      return {
        items: value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => ({ id: nextId(), value: item })),
        shouldMigrateLegacyValue: true,
      };
    }
  }

  return { items: [], shouldMigrateLegacyValue: false };
}

export function parseArrayValue(
  value: unknown,
  nextId: () => number
): ArrayItem[] {
  return parseArrayValueWithMigration(value, nextId).items;
}

function serializeItems(items: ArrayItem[]): unknown[] {
  return items.map((item) => item.value);
}

export function shouldMigrateLegacyArrayValue(value: unknown): value is string {
  return parseArrayValueWithMigration(value, () => 0).shouldMigrateLegacyValue;
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
  const migratedLegacyValue = useRef<string | null>(null);
  const nextId = (): number => {
    idCounter.current += 1;
    return idCounter.current;
  };

  const [items, setItems] = useState<ArrayItem[]>(() =>
    parseArrayValue(value, nextId)
  );

  useEffect(() => {
    const parsed = parseArrayValueWithMigration(value, nextId);
    const incoming = parsed.items;
    setItems(incoming);

    if (
      !disabled &&
      parsed.shouldMigrateLegacyValue &&
      migratedLegacyValue.current !== value
    ) {
      migratedLegacyValue.current = String(value);
      onChange(serializeItems(incoming));
    }
  }, [disabled, value]);

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
        disabled={disabled}
        onClick={addItem}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {isTuple ? "Add Object" : "Add Item"}
      </Button>
    </div>
  );
}
