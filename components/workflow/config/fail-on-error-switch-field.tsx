"use client";

import { SwitchField } from "@/components/workflow/config/switch-field";
import { toggleRuleOf } from "@/plugins/registry";

// HTTP Request's toggle is not a registry field, so the rule comes by type.
const FAIL_ON_ERROR_RULE = toggleRuleOf({ type: "fail-on-error-switch" });

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
 * plugin "fail-on-error-switch" field), so both read it by the rule the
 * registry gives that field type.
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
      rule={FAIL_ON_ERROR_RULE}
      label={label}
      onChange={onChange}
      resetOnly={resetOnly}
      value={value}
    />
  );
}
