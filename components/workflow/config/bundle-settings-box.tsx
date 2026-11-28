"use client";

import { useId } from "react";
import { MultiSelectPicker } from "@/components/workflow/config/multi-select-field";
import { UnixTimeField } from "@/components/workflow/config/unix-time-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bundleTipsText } from "@/lib/web3/bundles/editor-text";
import {
  READ_ONLY_LIST_PLACE,
  WAITING_BILLING_TEXT,
} from "@/lib/workflow/waiting-run-groups";
import {
  BUNDLE_SETTING_KEYS,
  builderDisplayName,
  DEFAULT_BUNDLE_BLOCKS,
  DEFAULT_SEND_AHEAD_BLOCKS,
  isUnset,
  MAX_BUNDLE_BLOCKS,
  readInteger,
} from "@/lib/web3/bundles/settings";
import { bundleSettingsFields } from "@/plugins/field-fragments";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type Update = (key: string, value: unknown) => void;

/** The bundle settings as the registry defines them: label, range, placeholder. */
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

// An error two settings share: each is marked invalid and shows its own line with this id.
type SharedError = { id: string; text: string };

type NumberSettingProps = {
  field: ActionConfigFieldBase;
  value: unknown;
  help: string;
  // A second line under the help.
  note?: string;
  shared?: SharedError;
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** One whole-number setting, with its range and what it does under it. */
function NumberSetting({
  field,
  value,
  help,
  note,
  shared,
  disabled,
  onChange,
}: NumberSettingProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const { min, max } = rangeOf(field);
  const outOfRange =
    !isUnset(value) && readSetting(field, value) === undefined;
  const invalid = outOfRange || shared !== undefined;
  const describedBy = [
    outOfRange ? errorId : undefined,
    shared?.id,
    helpId,
    note ? noteId : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-2">
      <Label className="ml-1" htmlFor={id}>
        {field.label}
      </Label>
      <Input
        aria-describedby={describedBy}
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
      {outOfRange && (
        <p className="ml-1 text-destructive text-xs" id={errorId}>
          Use a whole number from {min} to {max}.
        </p>
      )}
      {shared && (
        <p
          className="ml-1 text-destructive text-xs"
          data-testid={`${field.key}-shared-error`}
          id={shared.id}
        >
          {shared.text}
        </p>
      )}
      <p className="ml-1 text-muted-foreground text-xs" id={helpId}>
        {help}
      </p>
      {note && (
        <p className="ml-1 text-muted-foreground text-xs" id={noteId}>
          {note}
        </p>
      )}
    </div>
  );
}

const BUNDLE_DOCS_URL = "https://docs.keeperhub.com/plugins/web3#send-as-bundle";

// The billing line, with its docs place linked to the Send as Bundle section.
const [BILLING_BEFORE, BILLING_AFTER] =
  WAITING_BILLING_TEXT.split(READ_ONLY_LIST_PLACE);

const NOT_BEFORE_HINTS = [
  "Optional. The bundle never lands in a block before this time. Unix seconds, such as 1796126400, or a date with a time zone, such as 2026-12-01T12:00:00Z. Can be a template, such as {{Read Contract.result}}. Empty: sends for the next blocks.",
  <>
    A run that is too early sends nothing and ends Skipped (Waiting).{" "}
    {BILLING_BEFORE}
    <a
      className="underline hover:text-primary"
      href={BUNDLE_DOCS_URL}
      rel="noopener noreferrer"
      target="_blank"
    >
      {READ_ONLY_LIST_PLACE}
    </a>
    {BILLING_AFTER}
  </>,
] as const;

function isSetText(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : !isUnset(value);
}

function sendAheadHelp(ahead: number | undefined, range: string): string {
  const lands =
    "Each bundle still lands only in its own block, never before Not before.";
  if (ahead === undefined) {
    return range;
  }
  if (ahead === 0) {
    return `${range} Sends only once the first allowed block is the next one. ${lands}`;
  }
  return `${range} Sends up to ${ahead} ${ahead === 1 ? "block" : "blocks"} before the first allowed block, so the builders already hold the bundle when it starts. ${lands}`;
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
  const sumErrorId = useId();
  const blocksSumErrorId = useId();
  const blocksField = fieldOf(BUNDLE_SETTING_KEYS.blocks);
  const tipField = fieldOf(BUNDLE_SETTING_KEYS.tipIncreasePercent);
  const buildersField = fieldOf(BUNDLE_SETTING_KEYS.builders);
  const notBeforeField = fieldOf(BUNDLE_SETTING_KEYS.notBefore);
  const aheadField = fieldOf(BUNDLE_SETTING_KEYS.sendAheadBlocks);
  const blocksValue = config[blocksField.key];
  const tipValue = config[tipField.key];
  const notBeforeValue = config[notBeforeField.key];
  const aheadValue = config[aheadField.key];
  const blocksRead = isUnset(blocksValue)
    ? DEFAULT_BUNDLE_BLOCKS
    : readSetting(blocksField, blocksValue);
  const increaseRead = isUnset(tipValue) ? 0 : readSetting(tipField, tipValue);
  const aheadRead = isUnset(aheadValue)
    ? DEFAULT_SEND_AHEAD_BLOCKS
    : readSetting(aheadField, aheadValue);
  const blocksRange = rangeOf(blocksField);
  const tipRange = rangeOf(tipField);
  const aheadRange = rangeOf(aheadField);
  const notBeforeSet = isSetText(notBeforeValue);
  // Hidden without Not before, unless it holds a value a save would refuse.
  const showAhead =
    notBeforeSet || (!isUnset(aheadValue) && aheadRead === undefined);
  const overSum =
    notBeforeSet &&
    blocksRead !== undefined &&
    aheadRead !== undefined &&
    blocksRead + aheadRead > MAX_BUNDLE_BLOCKS;
  const sumText = overSum
    ? `Send ahead (${aheadRead}) + Target blocks (${blocksRead}) is ${aheadRead + blocksRead}. Together they can be at most ${MAX_BUNDLE_BLOCKS}, so lower one of them.`
    : "";
  // The short line under Target blocks; the full one is under Send ahead.
  const blocksSumText = overSum
    ? `With Send ahead, at most ${MAX_BUNDLE_BLOCKS} (now ${aheadRead + blocksRead}).`
    : "";
  const sumNote =
    overSum || blocksRead === undefined || aheadRead === undefined
      ? `Send ahead + Target blocks: at most ${MAX_BUNDLE_BLOCKS}.`
      : `Send ahead + Target blocks: at most ${MAX_BUNDLE_BLOCKS} (now ${aheadRead} + ${blocksRead}).`;

  let blocksHelp = `${blocksRange.min} to ${blocksRange.max}.`;
  if (blocksRead !== undefined) {
    let tries =
      blocksRead === 1
        ? "the next block"
        : `${blocksRead} blocks in a row, starting with the next one`;
    if (notBeforeSet) {
      tries =
        blocksRead === 1
          ? "the first block allowed by Not before"
          : `${blocksRead} blocks in a row, starting with the first block allowed by Not before`;
    }
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
      fromFirstAllowed: notBeforeSet,
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
        shared={
          overSum ? { id: blocksSumErrorId, text: blocksSumText } : undefined
        }
        value={blocksValue}
      />
      <UnixTimeField
        disabled={disabled}
        fieldKey={notBeforeField.key}
        hints={NOT_BEFORE_HINTS}
        label={notBeforeField.label}
        onChange={(next) => onUpdateConfig(notBeforeField.key, next)}
        placeholder={notBeforeField.placeholder}
        value={notBeforeValue}
      />
      {showAhead && (
        <NumberSetting
          disabled={disabled}
          field={aheadField}
          help={sendAheadHelp(
            aheadRead,
            `${aheadRange.min} to ${aheadRange.max}.`
          )}
          note={sumNote}
          onChange={(next) => onUpdateConfig(aheadField.key, next)}
          shared={overSum ? { id: sumErrorId, text: sumText } : undefined}
          value={aheadValue}
        />
      )}
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
