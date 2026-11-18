"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { hasTemplateToken, valueContainsTemplate } from "@/lib/workflow/template-ref";

type ProtocolBoolFieldProps = {
  fieldKey: string;
  value: string;
  unrecognized?: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

export type ProtocolBoolFieldValue = {
  value: string;
  // A saved value that is not a bool, shown so it is not mistaken for unset.
  unrecognized?: string;
};

const MAX_SHOWN_LENGTH = 60;

function describeSaved(saved: unknown): string {
  const text = JSON.stringify(saved) ?? String(saved);
  return text.length > MAX_SHOWN_LENGTH
    ? `${text.slice(0, MAX_SHOWN_LENGTH)}...`
    : text;
}

// A saved JSON true/false (agents may send one) shows as the matching option.
export function protocolBoolFieldValue(
  saved: unknown,
  defaultValue: string | undefined
): ProtocolBoolFieldValue {
  if (saved === undefined || saved === "") {
    return { value: defaultValue || "" };
  }
  if (typeof saved === "boolean") {
    return { value: String(saved) };
  }
  if (saved === "true" || saved === "false" || valueContainsTemplate(saved)) {
    return { value: saved as string };
  }
  return { value: "", unrecognized: describeSaved(saved) };
}

export function ProtocolBoolField({
  fieldKey,
  value,
  unrecognized,
  onChange,
  disabled,
}: ProtocolBoolFieldProps): React.ReactNode {
  const isTemplateValue = hasTemplateToken(value ?? "");

  if (isTemplateValue) {
    return (
      <TemplateBadgeInput
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder="true or false"
        value={value ?? ""}
      />
    );
  }

  const errorId = `${fieldKey}-unrecognized`;
  return (
    <div>
      <Select
        disabled={disabled}
        onValueChange={(val: string) => onChange(val)}
        value={value || ""}
      >
        <SelectTrigger
          aria-describedby={unrecognized ? errorId : undefined}
          aria-invalid={unrecognized ? true : undefined}
          id={fieldKey}
        >
          <SelectValue placeholder="Select true or false" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
      {unrecognized && (
        <p className="mt-1 break-all text-xs text-destructive" id={errorId}>
          Saved value {unrecognized} is not true or false. Pick one to replace
          it.
        </p>
      )}
    </div>
  );
}
