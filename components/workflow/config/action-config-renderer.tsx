"use client";

import { ChevronDown, Info } from "lucide-react";
import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { TupleInputField } from "@/components/workflow/config/tuple-input-field";
import { computeSelector } from "@/lib/abi-utils";
import { evaluateShowWhen } from "@/lib/workflow/show-when";
import { parseAddressBookSelection } from "@/lib/address-book-selection";
import { toChecksumAddress } from "@/lib/address-utils";
import { getCustomFieldRenderer } from "@/lib/extension-registry";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  isFieldGroup,
} from "@/plugins/registry";
import { SchemaBuilder, type SchemaField } from "./schema-builder";

type FieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
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
      schema={props.value ? (JSON.parse(props.value) as SchemaField[]) : []}
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

      return abi.filter(filterFn).map((func) => {
        const inputs = func.inputs || [];
        const params = inputs
          .map(
            (input: { name: string; type: string }) =>
              `${input.type} ${input.name}`
          )
          .join(", ");
        const inputTypes = inputs.map((input: { type: string }) => input.type);
        const selector = computeSelector(func.name, inputTypes);
        return {
          name: func.name,
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
          <SelectItem key={func.label} value={func.name}>
            <div className="flex flex-col items-start">
              <span>
                {func.label}{" "}
                <code className="text-muted-foreground text-xs">
                  ({func.selector})
                </code>
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
  const functionInputs = React.useMemo(() => {
    if (
      !(abiValue && functionValue) ||
      abiValue.trim() === "" ||
      functionValue.trim() === ""
    ) {
      return [];
    }

    try {
      const abi = JSON.parse(abiValue);
      if (!Array.isArray(abi)) {
        return [];
      }

      const func = abi.find(
        (item) => item.type === "function" && item.name === functionValue
      );

      if (!func?.inputs) {
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
  }, [abiValue, functionValue]);

  // Parse prop value into array
  const parsePropValue = React.useCallback((val: string): unknown[] => {
    if (!val || val.trim() === "") {
      return [];
    }
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, []);

  // Use local state to manage arg values - this prevents race conditions on blur
  const [localArgValues, setLocalArgValues] = React.useState<unknown[]>(() =>
    parsePropValue(value)
  );

  // Track the last function to detect when user selects a different function
  const lastFunctionRef = React.useRef(functionValue);

  // Sync from prop only when function changes (user selected different function)
  React.useEffect(() => {
    if (functionValue !== lastFunctionRef.current) {
      // Function changed - reset to prop value (which should be empty for new function)
      setLocalArgValues(parsePropValue(value));
      lastFunctionRef.current = functionValue;
    }
  }, [functionValue, value, parsePropValue]);

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
  const abiValue = (config[abiField] as string | undefined) || "";
  const value =
    (config[field.key] as string | undefined) || field.defaultValue || "";

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
  const abiValue = (config[abiField] as string | undefined) || "";
  const functionValue = (config[functionField] as string | undefined) || "";
  const value =
    (config[field.key] as string | undefined) || field.defaultValue || "";

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
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-pre-line" side="top">
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
