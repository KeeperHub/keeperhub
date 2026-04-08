"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { ArrayInputField } from "@/components/workflow/config/array-input-field";
import type { AbiComponent } from "@/components/workflow/config/abi-types";

type TupleInputFieldProps = {
  components: AbiComponent[];
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  fieldKey: string;
};

function parseObjectValue(
  value: unknown,
  components: AbiComponent[]
): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON
    }
  }

  const obj: Record<string, unknown> = {};
  for (const comp of components) {
    obj[comp.name] = "";
  }
  return obj;
}

export function TupleInputField({
  components,
  value,
  onChange,
  disabled,
  fieldKey,
}: TupleInputFieldProps): React.ReactNode {
  const obj = parseObjectValue(value, components);

  function handleFieldChange(name: string, fieldValue: unknown): void {
    onChange({ ...obj, [name]: fieldValue });
  }

  return (
    <div className="space-y-2 rounded-md border border-border/50 p-2.5">
      {components.map((comp) => {
        const isArray = comp.type.endsWith("[]");
        const hasSubs =
          comp.components !== undefined && comp.components.length > 0;
        const isTuple = comp.type === "tuple" && hasSubs;

        return (
          <div className="space-y-1" key={`${fieldKey}-${comp.name}`}>
            <label
              className="text-xs font-medium"
              htmlFor={`${fieldKey}-${comp.name}`}
            >
              {comp.name}{" "}
              <span className="text-muted-foreground">({comp.type})</span>
            </label>

            {isArray ? (
              <ArrayInputField
                components={hasSubs ? comp.components : undefined}
                disabled={disabled}
                fieldKey={`${fieldKey}-${comp.name}`}
                itemType={comp.type.slice(0, -2)}
                onChange={(val) => handleFieldChange(comp.name, val)}
                value={obj[comp.name]}
              />
            ) : isTuple ? (
              <TupleInputField
                components={comp.components ?? []}
                disabled={disabled}
                fieldKey={`${fieldKey}-${comp.name}`}
                onChange={(val) => handleFieldChange(comp.name, val)}
                value={obj[comp.name]}
              />
            ) : (
              <TemplateBadgeInput
                disabled={disabled}
                id={`${fieldKey}-${comp.name}`}
                onChange={(val) => handleFieldChange(comp.name, String(val))}
                placeholder={`Enter ${comp.type} value or {{NodeName.value}}`}
                value={(obj[comp.name] as string) ?? ""}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
