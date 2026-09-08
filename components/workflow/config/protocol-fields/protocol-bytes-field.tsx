"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { validateBytes } from "@/lib/solidity-type-fields";
import { useMemo } from "react";

type ProtocolBytesFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  solidityType?: string;
};

export function ProtocolBytesField({
  fieldKey,
  value,
  onChange,
  disabled,
  placeholder,
  solidityType,
}: ProtocolBytesFieldProps): React.ReactNode {
  const byteLength =
    solidityType && solidityType !== "bytes"
      ? Number(solidityType.slice(5))
      : undefined;

  const validation = useMemo(() => {
    if (!value || value === "") return null;
    const result = validateBytes(value, byteLength);
    return result.valid ? null : result.message;
  }, [value, byteLength]);

  return (
    <div>
      <TemplateBadgeInput
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder={placeholder ?? "0x"}
        value={value ?? ""}
      />
      {validation && (
        <p className="mt-1 text-xs text-destructive">{validation}</p>
      )}
    </div>
  );
}
