"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { validateEthValue } from "@/lib/solidity-type-fields";
import { useMemo } from "react";

type ProtocolEthValueFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function ProtocolEthValueField({
  fieldKey,
  value,
  onChange,
  disabled,
  placeholder,
}: ProtocolEthValueFieldProps): React.ReactNode {
  const validation = useMemo(() => {
    if (!value || value === "") {
      return null;
    }
    const result = validateEthValue(value);
    return result.valid ? null : result.message;
  }, [value]);

  return (
    <div>
      <TemplateBadgeInput
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder={placeholder ?? "0.0"}
        value={value ?? ""}
      />
      {validation && (
        <p className="mt-1 text-xs text-destructive">{validation}</p>
      )}
    </div>
  );
}
