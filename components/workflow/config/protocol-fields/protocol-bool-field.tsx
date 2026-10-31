"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { hasTemplateToken } from "@/lib/workflow/template-ref";

type ProtocolBoolFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

export function ProtocolBoolField({
  fieldKey,
  value,
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

  return (
    <Select
      disabled={disabled}
      onValueChange={(val: string) => onChange(val)}
      value={value || ""}
    >
      <SelectTrigger id={fieldKey}>
        <SelectValue placeholder="Select true or false" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true">true</SelectItem>
        <SelectItem value="false">false</SelectItem>
      </SelectContent>
    </Select>
  );
}
