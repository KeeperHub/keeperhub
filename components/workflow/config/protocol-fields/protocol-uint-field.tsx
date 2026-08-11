"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { validateUint } from "@/lib/solidity-type-fields";
import { useMemo } from "react";

type ProtocolUintFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  solidityType?: string;
};

export function ProtocolUintField({
  fieldKey,
  value,
  onChange,
  disabled,
  placeholder,
  solidityType,
}: ProtocolUintFieldProps): React.ReactNode {
  const bits = solidityType?.startsWith("int")
    ? Number(solidityType.slice(3) || "256")
    : Number((solidityType ?? "uint256").replace("uint", "") || "256");

  const validation = useMemo(() => {
    if (!value || value === "") return null;
    const result = validateUint(value, bits);
    return result.valid ? null : result.message;
  }, [value, bits]);

  return (
    <div>
      <TemplateBadgeInput
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder={placeholder ?? "0"}
        value={String(value ?? "")}
      />
      {validation && (
        <p className="mt-1 text-xs text-destructive">{validation}</p>
      )}
    </div>
  );
}
