"use client";

import { FailOnErrorSwitchField } from "@/components/workflow/config/fail-on-error-switch-field";
import { PlainSwitchField } from "@/components/workflow/config/plain-switch-field";
import { SponsorGasField } from "@/components/workflow/config/sponsor-gas-field";
import type { CustomFieldRenderer } from "@/lib/workflow/editor/extension-registry";
import { isShownOnlyToFix, type ToggleFieldType } from "@/plugins/registry";

/**
 * The form renderer of every on/off toggle field type, kept together so a
 * test can check each one, including that a toggle shown only to be fixed is
 * locked. Registered in lib/workflow/editor/extensions.tsx.
 */
export const TOGGLE_FIELD_RENDERERS: Readonly<
  Record<ToggleFieldType, CustomFieldRenderer>
> = {
  // Write Contract's "Fail workflow on error". Shares FailOnErrorSwitchField
  // with HTTP Request, so both read it by the same default-on rule.
  "fail-on-error-switch": ({ field, config, onUpdateConfig, disabled }) => (
    <FailOnErrorSwitchField
      description={field.helpTip ?? field.helpText}
      disabled={disabled}
      id={field.key}
      key={field.key}
      label={field.label}
      onChange={(next) => onUpdateConfig(field.key, next)}
      resetOnly={isShownOnlyToFix(field, config)}
      value={config[field.key]}
    />
  ),
  // A plain boolean toggle, read by resolveSwitch as its step reads it.
  switch: ({ field, config, onUpdateConfig, disabled }) => (
    <PlainSwitchField
      config={config}
      disabled={disabled}
      field={field}
      key={field.key}
      onUpdateConfig={onUpdateConfig}
    />
  ),
  // "Sponsor gas" on a web3 write. Default-on through resolveSponsorGas, so
  // the form and the step agree on what an unset value means.
  "gas-sponsorship-switch": ({ field, config, onUpdateConfig, disabled }) => (
    <SponsorGasField
      description={field.helpTip ?? field.helpText}
      disabled={disabled}
      id={field.key}
      key={field.key}
      label={field.label}
      // Clearing fees once the node becomes sponsored again is a general
      // rule, applied to every config change (clearUnsponsoredOnlyFields).
      onChange={(next) => onUpdateConfig(field.key, next)}
      resetOnly={isShownOnlyToFix(field, config)}
      value={config[field.key]}
    />
  ),
};
