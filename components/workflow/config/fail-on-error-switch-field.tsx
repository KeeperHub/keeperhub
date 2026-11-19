"use client";

import { SwitchField } from "@/components/workflow/config/switch-field";

type FailOnErrorSwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  value: unknown;
  onChange: (value: boolean | undefined) => void;
  disabled?: boolean;
  resetOnly: boolean;
};

/**
 * Shared "Fail workflow on error" toggle, used by both the HTTP Request
 * node (hardcoded system action) and the Write Contract node (declarative
 * plugin "fail-on-error-switch" field), so both read it by the default-on rule
 * (resolveDefaultOnFlag) in SwitchField.
 */
export function FailOnErrorSwitchField({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
  resetOnly,
}: FailOnErrorSwitchFieldProps) {
  return (
    <SwitchField
      description={description}
      disabled={disabled}
      id={id}
      rule="default-on"
      label={label}
      onChange={onChange}
      resetOnly={resetOnly}
      value={value}
    />
  );
}
