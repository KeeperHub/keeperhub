"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { validateInt } from "@/lib/solidity-type-fields";
import { useMemo } from "react";

type ProtocolIntFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  solidityType?: string;
};

export function ProtocolIntField({
  fieldKey,
  value,
  onChange,
  disabled,
  placeholder,
  solidityType,
}: ProtocolIntFieldProps): React.ReactNode {
  const bits = Number((solidityType ?? "int256").replace("int", "") || "256");

  const validation = useMemo(() => {
    if (!value || value === "") {
      return null;
    }
    const result = validateInt(value, bits);
    return result.valid ? null : result.message;
  }, [value, bits]);

  return (
    <div>
      <TemplateBadgeInput
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder={placeholder ?? "0"}
        value={value ?? ""}
      />
      {validation && (
        <p className="mt-1 text-xs text-destructive">{validation}</p>
      )}
    </div>
  );
}
