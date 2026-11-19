"use client";

import { SwitchField } from "@/components/workflow/config/switch-field";
import { resolveFailOnError } from "@/lib/utils";

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
 * plugin "fail-on-error-switch" field) so the default-on resolution logic
 * (resolveFailOnError) lives in exactly one place.
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
      isOn={resolveFailOnError}
      label={label}
      onChange={onChange}
      strayAtRun="When the step runs, it is on unless this resolves to false."
      resetOnly={resetOnly}
      value={value}
    />
  );
}
