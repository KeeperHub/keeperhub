"use client";

import { SwitchField } from "@/components/workflow/config/switch-field";
import { isToggleValue } from "@/lib/utils";
import {
  isSkipIfRunningSupported,
  isSlotClockChain,
  RUN_ON_MISSED_SLOT_LABEL,
  SKIP_IF_RUNNING_LABEL,
} from "@/lib/workflow/block-trigger-switches";

const OFF_BY_DEFAULT = { switchDefault: false } as const;
// The dispatcher reads anything but true as off; save refuses it.
const STRAY_HINT = "The trigger reads it as off.";

type BlockTriggerOptionsProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
};

const SWITCHES = [
  {
    key: "skipIfRunning",
    label: SKIP_IF_RUNNING_LABEL,
    description:
      "A block that fires while a run of this workflow is still going is recorded as Skipped and does not start a run.",
    shownOn: isSkipIfRunningSupported,
  },
  {
    key: "runOnMissedSlot",
    label: RUN_ON_MISSED_SLOT_LABEL,
    description:
      "Ethereum only. Works only with Block Interval 1. When no block arrives 4 s into a slot, the workflow runs anyway.",
    shownOn: isSlotClockChain,
  },
] as const;

export function BlockTriggerOptions({
  config,
  onUpdateConfig,
  disabled,
}: BlockTriggerOptionsProps) {
  // Trigger config is stored as strings; clearing a stray value stores "".
  const update =
    (key: string) =>
    (next: boolean | undefined): void =>
      onUpdateConfig(key, next === undefined ? "" : String(next));
  // A switch the network does not use still shows while it holds a stray value, locked, so it can be reset.
  const visible = SWITCHES.filter(
    (s) => s.shownOn(config.network) || !isToggleValue(config[s.key])
  );
  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {visible.map((s) => (
        <SwitchField
          description={s.description}
          disabled={disabled}
          id={s.key}
          key={s.key}
          label={s.label}
          onChange={update(s.key)}
          resetOnly={!s.shownOn(config.network)}
          rule={OFF_BY_DEFAULT}
          focusOnLockedReset="#network"
          lockedHint="Not used on this network."
          strayHint={STRAY_HINT}
          value={config[s.key]}
        />
      ))}
    </div>
  );
}
