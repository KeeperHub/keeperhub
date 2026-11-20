"use client";

import type * as React from "react";

import { SwitchField } from "@/components/workflow/config/switch-field";
import {
  type ActionConfigFieldBase,
  isShownOnlyToFix,
  toggleRuleOf,
} from "@/plugins/registry";

type PlainSwitchFieldProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
};

export function PlainSwitchField({
  field,
  config,
  onUpdateConfig,
  disabled,
}: PlainSwitchFieldProps): React.ReactElement {
  return (
    <SwitchField
      description={field.helpText ?? field.helpTip}
      disabled={disabled}
      id={field.key}
      label={field.label}
      onChange={(next) => onUpdateConfig(field.key, next)}
      resetOnly={isShownOnlyToFix(field, config)}
      rule={toggleRuleOf(field)}
      value={config[field.key]}
    />
  );
}
