"use client";

import { useId } from "react";
import { MultiSelectPicker } from "@/components/workflow/config/multi-select-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bundleTipsText } from "@/lib/web3/bundles/editor-text";
import {
  BUNDLE_SETTING_KEYS,
  builderDisplayName,
  DEFAULT_BUNDLE_BLOCKS,
  isUnset,
  readInteger,
} from "@/lib/web3/bundles/settings";
import { bundleSettingsFields } from "@/plugins/field-fragments";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type Update = (key: string, value: unknown) => void;

/** The three bundle settings as the registry defines them: label, range, placeholder. */
const FIELDS = new Map(
  bundleSettingsFields().map((field) => [field.key, field])
);

function fieldOf(key: string): ActionConfigFieldBase {
  const field = FIELDS.get(key);
  if (!field) {
    throw new Error(`No bundle setting field ${key}`);
  }
  return field;
}

function rangeOf(field: ActionConfigFieldBase): { min: number; max: number } {
  return { min: field.min ?? 0, max: field.max ?? Number.MAX_SAFE_INTEGER };
}

/** The setting's value read as a step reads it; undefined when unset or out of range. */
function readSetting(field: ActionConfigFieldBase, value: unknown) {
  return readInteger(value, rangeOf(field));
}

type NumberSettingProps = {
  field: ActionConfigFieldBase;
  value: unknown;
  help: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** One whole-number setting, with its range and what it does under it. */
function NumberSetting({
  field,
  value,
  help,
  disabled,
  onChange,
}: NumberSettingProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const { min, max } = rangeOf(field);
  const invalid = !isUnset(value) && readSetting(field, value) === undefined;
  return (
    <div className="space-y-2">
      <Label className="ml-1" htmlFor={id}>
        {field.label}
      </Label>
      <Input
        aria-describedby={invalid ? `${errorId} ${helpId}` : helpId}
        aria-invalid={invalid || undefined}
        data-setting={field.key}
        disabled={disabled}
        id={id}
        inputMode="numeric"
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        step={1}
        type="number"
        value={isUnset(value) ? "" : String(value)}
      />
      {invalid && (
        <p className="ml-1 text-destructive text-xs" id={errorId}>
          Use a whole number from {min} to {max}.
        </p>
      )}
      <p className="ml-1 text-muted-foreground text-xs" id={helpId}>
        {help}
      </p>
    </div>
  );
}

type BundleSettingsBoxProps = {
  config: Record<string, unknown>;
  onUpdateConfig: Update;
  disabled?: boolean;
  /** The network's builder names; undefined while the network is not known. */
  builders: readonly string[] | undefined;
  /** The network's tip limit in gwei; undefined while not known. */
  tipLimitGwei?: number;
};

/** The bundle settings, indented under Send as while it is Bundle. */
export function BundleSettingsBox({
  config,
  onUpdateConfig,
  disabled,
  builders,
  tipLimitGwei,
}: BundleSettingsBoxProps) {
  const headingId = useId();
  const blocksField = fieldOf(BUNDLE_SETTING_KEYS.blocks);
  const tipField = fieldOf(BUNDLE_SETTING_KEYS.tipIncreasePercent);
  const buildersField = fieldOf(BUNDLE_SETTING_KEYS.builders);
  const blocksValue = config[blocksField.key];
  const tipValue = config[tipField.key];
  const blocksRead = isUnset(blocksValue)
    ? DEFAULT_BUNDLE_BLOCKS
    : readSetting(blocksField, blocksValue);
  const increaseRead = isUnset(tipValue) ? 0 : readSetting(tipField, tipValue);
  const blocksRange = rangeOf(blocksField);
  const tipRange = rangeOf(tipField);

  let blocksHelp = `${blocksRange.min} to ${blocksRange.max}.`;
  if (blocksRead !== undefined) {
    const tries =
      blocksRead === 1
        ? "the next block"
        : `${blocksRead} blocks in a row, starting with the next one`;
    blocksHelp = `${blocksHelp} Tries ${tries}, then the step ends. ${blocksField.helpText ?? ""}`;
  }
  // The tips line follows both numbers, so it waits until both are in range.
  let tipHelp = `${tipRange.min} to ${tipRange.max}.`;
  if (blocksRead !== undefined && increaseRead !== undefined) {
    tipHelp = `${tipHelp} ${bundleTipsText({
      blocks: blocksRead,
      increasePercent: increaseRead,
      priorityFeeGwei: config.priorityFeeGwei,
      maxFeeGwei: config.maxFeeGwei,
      tipLimitGwei,
    })}`;
  }

  return (
    <div
      aria-labelledby={headingId}
      className="ml-1 space-y-4 border-primary/50 border-l-2 py-1 pl-3"
      data-testid="bundle-settings"
      role="group"
    >
      <span className="sr-only" id={headingId}>
        Bundle settings
      </span>
      <NumberSetting
        disabled={disabled}
        field={blocksField}
        help={blocksHelp.trim()}
        onChange={(next) => onUpdateConfig(blocksField.key, next)}
        value={blocksValue}
      />
      <MultiSelectPicker
        allHint={buildersField.helpText ?? ""}
        allLabel="All builders"
        choices={builders?.map((name) => ({
          value: name,
          label: builderDisplayName(name),
        }))}
        disabled={disabled}
        label={buildersField.label}
        max={buildersField.max}
        missingNote={(names) =>
          `Not on this network: ${names.join(", ")}. Runs skip ${names.length === 1 ? "it" : "them"}; changing these settings is refused until ${names.length === 1 ? "it is" : "they are"} removed.`
        }
        missingSuffix="not on this network"
        noun="builders"
        onChange={(next) => onUpdateConfig(buildersField.key, next)}
        testId="bundle-builders"
        unknownNote="The network's builders are checked when the step runs."
        value={config[buildersField.key]}
      />
      <NumberSetting
        disabled={disabled}
        field={tipField}
        help={tipHelp}
        onChange={(next) => onUpdateConfig(tipField.key, next)}
        value={tipValue}
      />
      <p
        className="ml-1 text-muted-foreground text-xs"
        data-testid="bundle-settings-note"
      >
        Gas Limit in Advanced caps the simulation run for each target block. A
        missed bundle's signed transactions stay valid until something else is
        mined at that nonce, so put a deadline in the calldata for calls that
        must not run late.
      </p>
    </div>
  );
}
