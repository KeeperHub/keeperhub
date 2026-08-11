"use client";

import { ChevronDown, Info } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SUPPORTED_TIMEZONES,
  TimezoneSelect,
} from "@/components/ui/timezone-select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { SaveAddressBookmark } from "@/components/address-book/save-address-bookmark";
import type { AbiComponent } from "@/components/workflow/config/abi-types";
import { ArrayInputField } from "@/components/workflow/config/array-input-field";
import { MalformedAbiArgsNotice } from "@/components/workflow/config/malformed-abi-notice";
import { TupleInputField } from "@/components/workflow/config/tuple-input-field";
import {
  isValidAbiInput,
  resolveFunctionInputs,
} from "@/lib/abi/function-inputs";
import { parseAbiFunctionArgs } from "@/lib/abi/parse-args";
import { computeSelector } from "@/lib/abi/utils";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import { parseAddressBookSelection } from "@/lib/address-book-selection";
import { toChecksumAddress } from "@/lib/address-utils";
import { parseSchemaFields } from "@/lib/schema-fields";
import { getCustomFieldRenderer } from "@/lib/workflow/editor/extension-registry";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  isFieldGroup,
} from "@/plugins/registry";
import { SchemaBuilder } from "./schema-builder";

type FieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  // Writes an arbitrary config key. Fields that persist companion metadata
  // (e.g. a datetime field's display timezone) use this instead of `onChange`,
  // which is pinned to `field.key`.
  onUpdateConfig?: (key: string, value: unknown) => void;
  disabled?: boolean;
  config?: Record<string, unknown>;
  nodeId?: string;
};

function TemplateInputField({
  field,
  value,
  onChange,
  disabled,
  config,
  nodeId,
}: FieldProps) {
  const isAddressField =
    field.isAddressField === true ||
    field.key === "contractAddress" ||
    field.key === "recipientAddress" ||
    field.key === "address" ||
    field.key.toLowerCase().endsWith("address");

  const displayValue = isAddressField
    ? toChecksumAddress(value ?? "")
    : (value ?? "");

  const input = (
    <TemplateBadgeInput
      disabled={disabled}
      id={field.key}
      onChange={onChange}
      placeholder={field.placeholder}
      value={displayValue}
    />
  );

  if (isAddressField) {
    const selectionMap = config ? parseAddressBookSelection(config) : {};
    const selectedBookmarkId = selectionMap[field.key];
    return (
      <SaveAddressBookmark
        fieldKey={field.key}
        nodeId={nodeId}
        selectedBookmarkId={selectedBookmarkId}
      >
        {input}
      </SaveAddressBookmark>
    );
  }

  return input;
}

function TemplateTextareaField({
  field,
  value,
  onChange,
  disabled,
}: FieldProps) {
  return (
    <TemplateBadgeTextarea
      disabled={disabled}
      id={field.key}
      onChange={onChange}
      placeholder={field.placeholder}
      rows={field.rows || 4}
      value={value}
    />
  );
}

function TextInputField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <Input
      disabled={disabled}
      id={field.key}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      value={value}
    />
  );
}

function NumberInputField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <Input
      disabled={disabled}
      id={field.key}
      max={field.max}
      min={field.min}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      step={field.step}
      type="number"
      value={value}
    />
  );
}

// Minutes the IANA `timeZone` is ahead of UTC at a given instant (handles DST).
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return (asUtc - instant.getTime()) / 60_000;
}

// Stored UTC instant -> the "YYYY-MM-DDTHH:MM" wall-clock the picker shows for
// the chosen zone. "" for empty/unparseable values (legacy unix / template).
function instantToWall(iso: string, timeZone: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const shifted = new Date(date.getTime() + tzOffsetMinutes(date, timeZone) * 60_000);
  return shifted.toISOString().slice(0, 16);
}

// Wall-clock the user entered in `timeZone` -> the absolute UTC instant to store.
function wallToInstant(wall: string, timeZone: string): string {
  const naiveUtc = new Date(`${wall}:00Z`);
  if (Number.isNaN(naiveUtc.getTime())) {
    return "";
  }
  const firstOffset = tzOffsetMinutes(naiveUtc, timeZone);
  const candidate = new Date(naiveUtc.getTime() - firstOffset * 60_000);
  // Re-derive the offset at the candidate instant to settle DST boundaries.
  const settledOffset = tzOffsetMinutes(candidate, timeZone);
  return new Date(naiveUtc.getTime() - settledOffset * 60_000).toISOString();
}

type DateTimeMode = "absolute" | "relative" | "dynamic";

// Relative offset from the run time: "+2h", "+30m", "+7d" (optional "now" prefix).
const RELATIVE_OFFSET_RE = /^(?:now)?\+(\d+)\s*([mhd])$/i;
const RELATIVE_UNITS: { value: string; label: string }[] = [
  { value: "m", label: "Minutes" },
  { value: "h", label: "Hours" },
  { value: "d", label: "Days" },
];
const DATETIME_MODES: { value: DateTimeMode; label: string }[] = [
  { value: "absolute", label: "Fixed date" },
  { value: "relative", label: "Relative" },
  { value: "dynamic", label: "Dynamic" },
];

// The stored value's shape selects the editor: "{{..}}" is a template reference,
// "+2h" is a relative offset, anything else is an absolute instant.
function inferDateTimeMode(value: string): DateTimeMode {
  if (value.startsWith("{{")) {
    return "dynamic";
  }
  if (RELATIVE_OFFSET_RE.test(value)) {
    return "relative";
  }
  return "absolute";
}

function DateTimeModeToggle({
  mode,
  onMode,
  disabled,
}: {
  mode: DateTimeMode;
  onMode: (mode: DateTimeMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1">
      {DATETIME_MODES.map((option) => (
        <Button
          disabled={disabled}
          key={option.value}
          onClick={() => onMode(option.value)}
          size="sm"
          type="button"
          variant={mode === option.value ? "default" : "outline"}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

// Number + unit, stored as "+<n><unit>" and resolved against the run time by the
// step, so the window is recomputed fresh on every run instead of going stale.
function RelativeOffsetInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const match = RELATIVE_OFFSET_RE.exec(value);
  // Hold amount + unit in local state so the unit selection sticks even before
  // an amount is typed. Deriving both from the "+<n><unit>" string dropped the
  // unit whenever the amount was empty (nothing to store).
  const [amount, setAmount] = useState<string>(match?.[1] ?? "");
  const [unit, setUnit] = useState<string>((match?.[2] ?? "h").toLowerCase());
  const write = (nextAmount: string, nextUnit: string): void => {
    const trimmed = nextAmount.trim();
    onChange(trimmed ? `+${trimmed}${nextUnit}` : "");
  };
  const handleAmount = (next: string): void => {
    setAmount(next);
    write(next, unit);
  };
  const handleUnit = (next: string): void => {
    setUnit(next);
    write(amount, next);
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        className="w-24"
        disabled={disabled}
        id={id}
        min={1}
        onChange={(e) => handleAmount(e.target.value)}
        placeholder="2"
        type="number"
        value={amount}
      />
      <div className="w-32 [&_button]:w-full">
        <Select disabled={disabled} onValueChange={handleUnit} value={unit}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RELATIVE_UNITS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <span className="text-muted-foreground text-sm">after the run</span>
    </div>
  );
}

// Date/time field with three modes. The value is an absolute UTC ISO instant, a
// relative offset ("+2h"), or a template ("{{@Node.date}}") -- all resolved to
// unix seconds by the step at run time. Absolute mode persists its display zone
// as `_tz_<key>` metadata (like the schedule trigger's `scheduleTimezone`) so a
// reload shows the same wall-clock the user entered.
function DateTimeField({
  field,
  value,
  onChange,
  onUpdateConfig,
  disabled,
  config,
}: FieldProps) {
  const tzKey = `_tz_${field.key}`;
  const storedTz = config?.[tzKey];
  const [mode, setMode] = useState<DateTimeMode>(() =>
    inferDateTimeMode(value)
  );

  const [browserTz, setBrowserTz] = useState<string>("UTC");
  useEffect(() => {
    // Default to the browser zone only when the picker can render it; otherwise
    // fall back to UTC so the trigger never shows blank.
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setBrowserTz(detected && SUPPORTED_TIMEZONES.has(detected) ? detected : "UTC");
  }, []);

  // Prefer the saved zone; fall back to the browser zone only when none stored.
  const timeZone =
    typeof storedTz === "string" && SUPPORTED_TIMEZONES.has(storedTz)
      ? storedTz
      : browserTz;

  const changeMode = (next: DateTimeMode): void => {
    if (next === mode) {
      return;
    }
    setMode(next);
    // The three encodings are not interchangeable, so clear on a mode switch.
    onChange("");
    // Only Absolute mode carries a display zone; drop the companion metadata
    // when leaving it so a stale `_tz_<key>` is not persisted.
    if (next !== "absolute" && storedTz !== undefined) {
      onUpdateConfig?.(tzKey, undefined);
    }
  };

  // Reinterpret the current wall-clock in the new zone (so "09:00" stays 09:00,
  // now in the chosen zone) and persist the recomputed instant plus the zone.
  const handleTimeZoneChange = (nextZone: string): void => {
    onUpdateConfig?.(tzKey, nextZone);
    if (value) {
      const wall = instantToWall(value, timeZone);
      if (wall) {
        onChange(wallToInstant(wall, nextZone));
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <DateTimeModeToggle disabled={disabled} mode={mode} onMode={changeMode} />
      {mode === "absolute" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            disabled={disabled}
            id={field.key}
            onChange={(e) =>
              onChange(
                e.target.value ? wallToInstant(e.target.value, timeZone) : ""
              )
            }
            type="datetime-local"
            value={instantToWall(value, timeZone)}
          />
          {/* Capped + truncated so the long IANA label never stretches the row. */}
          <div className="w-40 shrink-0 [&_button]:w-full">
            <TimezoneSelect
              disabled={disabled}
              id={`${field.key}-tz`}
              onValueChange={handleTimeZoneChange}
              value={timeZone}
            />
          </div>
        </div>
      )}
      {mode === "relative" && (
        <RelativeOffsetInput
          disabled={disabled}
          id={field.key}
          onChange={onChange}
          value={value}
        />
      )}
      {mode === "dynamic" && (
        <TemplateBadgeInput
          disabled={disabled}
          id={field.key}
          onChange={onChange}
          placeholder="{{@Node.date}}"
          value={value}
        />
      )}
    </div>
  );
}

function SelectField({ field, value, onChange, disabled }: FieldProps) {
  if (!field.options) {
    return null;
  }

  return (
    <Select disabled={disabled} onValueChange={onChange} value={value}>
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={field.placeholder} />
      </SelectTrigger>
      <SelectContent>
        {field.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SchemaBuilderField(props: FieldProps) {
  return (
    <SchemaBuilder
      disabled={props.disabled}
      onChange={(schema) => props.onChange(JSON.stringify(schema))}
      schema={parseSchemaFields(props.value)}
    />
  );
}

export type AbiFunctionSelectProps = FieldProps & {
  abiValue: string;
  functionFilter?: "read" | "write";
};

export function AbiFunctionSelectField({
  field,
  value,
  onChange,
  disabled,
  abiValue,
  functionFilter = "read",
}: AbiFunctionSelectProps) {
  // Parse ABI and extract functions
  const functions = React.useMemo(() => {
    if (!abiValue || abiValue.trim() === "") {
      return [];
    }

    try {
      const abi = JSON.parse(abiValue);
      if (!Array.isArray(abi)) {
        return [];
      }

      // Filter functions based on functionFilter prop
      const filterFn =
        functionFilter === "write"
          ? (item: { type: string; stateMutability?: string }) =>
              item.type === "function" &&
              item.stateMutability !== "view" &&
              item.stateMutability !== "pure"
          : (item: { type: string; stateMutability?: string }) =>
              item.type === "function" &&
              (item.stateMutability === "view" ||
                item.stateMutability === "pure");

      const filtered = abi.filter(filterFn);

      // Count how many times each function name appears to detect overloads
      const nameCounts = new Map<string, number>();
      for (const func of filtered) {
        nameCounts.set(func.name, (nameCounts.get(func.name) ?? 0) + 1);
      }

      return filtered.map((func) => {
        const inputs = Array.isArray(func.inputs) ? func.inputs : [];
        // A parameter with no type cannot be encoded, so the function is still
        // listed (selecting it explains the problem) but gets no selector.
        const complete = inputs.every(isValidAbiInput);
        const inputTypes = inputs.map((input: { type?: unknown }) =>
          typeof input?.type === "string" ? input.type : "?"
        );
        const params = inputs
          .map((input: { name?: unknown }, index: number) =>
            `${inputTypes[index]} ${typeof input?.name === "string" ? input.name : ""}`.trim()
          )
          .join(", ");
        const selector = complete ? computeSelector(func.name, inputs) : null;
        const isOverloaded = (nameCounts.get(func.name) ?? 0) > 1;
        const key = isOverloaded
          ? `${func.name}(${inputTypes.join(",")})`
          : func.name;
        return {
          key,
          label: `${func.name}(${params})`,
          stateMutability: func.stateMutability || "nonpayable",
          selector,
        };
      });
    } catch {
      return [];
    }
  }, [abiValue, functionFilter]);

  if (functions.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {abiValue
          ? "No functions found in ABI"
          : "Enter ABI above to see available functions"}
      </div>
    );
  }

  return (
    <Select disabled={disabled} onValueChange={onChange} value={value}>
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={field.placeholder || "Select a function"} />
      </SelectTrigger>
      <SelectContent>
        {functions.map((func) => (
          <SelectItem key={func.key} value={func.key}>
            <div className="flex flex-col items-start">
              <span>
                {func.label}{" "}
                {func.selector && (
                  <code className="text-muted-foreground text-xs">
                    ({func.selector})
                  </code>
                )}
              </span>
              <span className="text-muted-foreground text-xs">
                {func.stateMutability}
              </span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export type AbiFunctionArgsProps = FieldProps & {
  abiValue: string;
  functionValue: string;
};

export function AbiFunctionArgsField({
  field,
  value,
  onChange,
  disabled,
  abiValue,
  functionValue,
}: AbiFunctionArgsProps) {
  // Parse the function inputs from the ABI
  const { inputs: functionInputs, malformed } = React.useMemo(
    () => resolveFunctionInputs(abiValue, functionValue),
    [abiValue, functionValue]
  );

  // Use local state to manage arg values - this prevents race conditions on blur
  const [localArgValues, setLocalArgValues] = React.useState<unknown[]>(() =>
    parseAbiFunctionArgs(value)
  );

  // Track the last function to detect when user selects a different function
  const lastFunctionRef = React.useRef(functionValue);

  // Sync from prop only when function changes (user selected different function)
  React.useEffect(() => {
    if (functionValue !== lastFunctionRef.current) {
      // Function changed - reset to prop value (which should be empty for new function)
      setLocalArgValues(parseAbiFunctionArgs(value));
      lastFunctionRef.current = functionValue;
    }
  }, [functionValue, value]);

  // Handle individual arg change - update local state and propagate to parent
  const handleArgChange = (index: number, newValue: unknown) => {
    const newArgs = [...localArgValues];
    // Ensure array is long enough
    while (newArgs.length <= index) {
      newArgs.push("");
    }
    newArgs[index] = newValue;
    // Update local state
    setLocalArgValues(newArgs);
    // Propagate to parent (outside of setState to avoid render-phase updates)
    onChange(JSON.stringify(newArgs));
  };

  if (malformed) {
    return <MalformedAbiArgsNotice />;
  }

  if (functionInputs.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        {functionValue
          ? "This function has no parameters"
          : "Select a function above to see parameters"}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {functionInputs.map(
        (
          input: { name: string; type: string; components?: AbiComponent[] },
          index: number,
        ) => {
          const isArray = input.type.endsWith("[]");
          const baseType = isArray ? input.type.slice(0, -2) : input.type;
          const hasTupleComponents =
            input.components !== undefined && input.components.length > 0;
          const isTuple = baseType === "tuple" && hasTupleComponents;

          return (
            <div className="space-y-1.5" key={`${field.key}-arg-${index}`}>
              <Label className="ml-1 text-xs" htmlFor={`${field.key}-${index}`}>
                {input.name}{" "}
                <span className="text-muted-foreground">({input.type})</span>
              </Label>
              {isArray ? (
                <ArrayInputField
                  components={isTuple ? input.components : undefined}
                  disabled={disabled}
                  fieldKey={`${field.key}-${index}`}
                  itemType={baseType}
                  onChange={(val) => handleArgChange(index, val)}
                  value={localArgValues[index]}
                />
              ) : isTuple ? (
                <TupleInputField
                  components={input.components ?? []}
                  disabled={disabled}
                  fieldKey={`${field.key}-${index}`}
                  onChange={(val) => handleArgChange(index, val)}
                  value={localArgValues[index]}
                />
              ) : (
                <TemplateBadgeInput
                  disabled={disabled}
                  id={`${field.key}-${index}`}
                  onChange={(val) => handleArgChange(index, val as string)}
                  placeholder={`Enter ${input.type} value or {{NodeName.value}}`}
                  value={(localArgValues[index] as string) || ""}
                />
              )}
            </div>
          );
        }
      )}
    </div>
  );
}

const FIELD_RENDERERS: Partial<
  Record<ActionConfigFieldBase["type"], React.ComponentType<FieldProps>>
> = {
  "template-input": TemplateInputField,
  "template-textarea": TemplateTextareaField,
  text: TextInputField,
  number: NumberInputField,
  datetime: DateTimeField,
  select: SelectField,
  "schema-builder": SchemaBuilderField,
};


/**
 * Helper: Render abi-function-select field.
 *
 * Mutability is not persisted; fields that want to gate on it use
 * `showWhen: { computed: "abiFunctionMutability", ... }` which derives
 * the value live from the ABI at render time.
 */
function renderAbiFunctionSelect(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: unknown) => void,
  disabled?: boolean
) {
  const abiField = field.abiField || "abi";
  const rawAbi = config[abiField];
  const abiValue = typeof rawAbi === "string" ? rawAbi : "";
  const rawValue = config[field.key];
  const value =
    (typeof rawValue === "string" ? rawValue : "") || field.defaultValue || "";

  return (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
      </Label>
      <AbiFunctionSelectField
        abiValue={abiValue}
        disabled={disabled}
        field={field}
        functionFilter={field.functionFilter}
        onChange={(val) => onUpdateConfig(field.key, val)}
        value={value}
      />
    </div>
  );
}


/**
 * Helper: Render abi-function-args field
 */
function renderAbiFunctionArgs(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: unknown) => void,
  disabled?: boolean
) {
  const abiField = field.abiField || "abi";
  const functionField = field.abiFunctionField || "abiFunction";
  const rawAbi = config[abiField];
  const abiValue = typeof rawAbi === "string" ? rawAbi : "";
  const rawFunction = config[functionField];
  const functionValue = typeof rawFunction === "string" ? rawFunction : "";
  const rawValue = config[field.key];
  const value =
    (typeof rawValue === "string" ? rawValue : "") || field.defaultValue || "";

  return (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
      </Label>
      <AbiFunctionArgsField
        abiValue={abiValue}
        disabled={disabled}
        field={field}
        functionValue={functionValue}
        onChange={(val) => onUpdateConfig(field.key, val)}
        value={value}
      />
    </div>
  );
}

/**
 * Helper: Render custom field types via extension registry
 */
function renderCustomField(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: unknown) => void,
  disabled?: boolean
) {
  const renderer = getCustomFieldRenderer(field.type);
  if (!renderer) {
    return null;
  }

  return renderer({ field, config, onUpdateConfig, disabled });
}

/**
 * Renders a single base field
 */
function renderField(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: unknown) => void,
  disabled?: boolean,
  nodeId?: string
) {
  // Check conditional rendering
  if (field.hidden) {
    return null;
  }

  if (!evaluateShowWhen(field.showWhen, config)) {
    return null;
  }

  const value =
    (config[field.key] as string | undefined) || field.defaultValue || "";

  // Special handling for abi-function-select
  if (field.type === "abi-function-select") {
    return renderAbiFunctionSelect(field, config, onUpdateConfig, disabled);
  }

  // Special handling for abi-function-args
  if (field.type === "abi-function-args") {
    return renderAbiFunctionArgs(field, config, onUpdateConfig, disabled);
  }

  // Check for custom field renderers (extension registry)
  const customResult = renderCustomField(
    field,
    config,
    onUpdateConfig,
    disabled
  );
  if (customResult !== null) {
    return customResult;
  }

  const FieldRenderer = FIELD_RENDERERS[field.type];

  if (!FieldRenderer) {
    return null;
  }

  return (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1 flex items-center gap-1.5" htmlFor={field.key}>
        {field.label}
        {field.required && <span className="text-red-500">*</span>}
        {field.helpTip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="inline-flex"
                onClick={() => {
                  if (field.docUrl) {
                    window.open(field.docUrl, "_blank", "noopener,noreferrer");
                  }
                }}
                type="button"
              >
                <Info className={`h-3.5 w-3.5 shrink-0 text-muted-foreground ${field.docUrl ? "cursor-pointer hover:text-primary" : "cursor-help"}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent
              className={`max-w-xs whitespace-pre-line ${field.docUrl ? "cursor-pointer" : ""}`}
              onClick={() => {
                if (field.docUrl) {
                  window.open(field.docUrl, "_blank", "noopener,noreferrer");
                }
              }}
              side="top"
            >
              {field.helpTip}
            </TooltipContent>
          </Tooltip>
        )}
      </Label>
      <FieldRenderer
        config={config}
        disabled={disabled}
        field={field}
        nodeId={nodeId}
        onChange={(val: unknown) => onUpdateConfig(field.key, val)}
        onUpdateConfig={onUpdateConfig}
        value={value}
      />
    </div>
  );
}

/**
 * Collapsible field group component
 */
function FieldGroup({
  label,
  fields,
  config,
  onUpdateConfig,
  disabled,
  defaultExpanded = false,
  nodeId,
}: {
  label: string;
  fields: ActionConfigFieldBase[];
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
  defaultExpanded?: boolean;
  nodeId?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="space-y-2">
      <button
        className="ml-1 flex items-center gap-1 text-left"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <span className="font-medium text-sm">{label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${
            isExpanded ? "" : "-rotate-90"
          }`}
        />
      </button>
      {isExpanded && (
        <div className="ml-1 space-y-4 border-primary/50 border-l-2 py-2 pl-3">
          {fields.map((field) =>
            renderField(field, config, onUpdateConfig, disabled, nodeId)
          )}
        </div>
      )}
    </div>
  );
}

type ActionConfigRendererProps = {
  fields: ActionConfigField[];
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
  nodeId?: string;
};

/**
 * Renders action config fields declaratively
 * Converts ActionConfigField definitions into actual UI components
 */
export function ActionConfigRenderer({
  fields,
  config,
  onUpdateConfig,
  disabled,
  nodeId,
}: ActionConfigRendererProps) {
  return (
    <>
      {fields.map((field) => {
        if (isFieldGroup(field)) {
          return (
            <FieldGroup
              config={config}
              defaultExpanded={field.defaultExpanded}
              disabled={disabled}
              fields={field.fields}
              key={`group-${field.label}`}
              label={field.label}
              nodeId={nodeId}
              onUpdateConfig={onUpdateConfig}
            />
          );
        }

        return renderField(
          field,
          config,
          onUpdateConfig,
          disabled,
          nodeId
        );
      })}
    </>
  );
}
