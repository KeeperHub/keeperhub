"use client";

import { SwitchField } from "@/components/workflow/config/switch-field";
import { resolveFailOnError } from "@/lib/utils";

type FailOnErrorSwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  value: unknown;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
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
}: FailOnErrorSwitchFieldProps) {
  return (
    <SwitchField
      checked={resolveFailOnError(value)}
      description={description}
      disabled={disabled}
      id={id}
      label={label}
      onChange={onChange}
    />
  );
}
