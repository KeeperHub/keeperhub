"use client";

import type * as React from "react";

import { SwitchField } from "@/components/workflow/config/switch-field";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type PlainSwitchFieldProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
};

// Unset falls back to defaultValue, so the form shows what the step will do.
export function isSwitchOn(value: unknown, defaultValue: unknown): boolean {
  const raw = value ?? defaultValue;
  return raw === true || raw === "true";
}

export function PlainSwitchField({
  field,
  config,
  onUpdateConfig,
  disabled,
}: PlainSwitchFieldProps): React.ReactElement {
  return (
    <SwitchField
      checked={isSwitchOn(config[field.key], field.defaultValue)}
      description={field.helpText ?? field.helpTip}
      disabled={disabled}
      id={field.key}
      label={field.label}
      onChange={(checked) => onUpdateConfig(field.key, checked)}
      storedValue={config[field.key]}
    />
  );
}
