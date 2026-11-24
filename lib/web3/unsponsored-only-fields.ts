import type { ActionConfigFieldBase } from "@/plugins/registry";

export const SPONSORSHIP_GAS_SETTINGS_DOC_URL =
  "https://docs.keeperhub.com/wallet-management/gas#custom-gas-settings-and-sponsorship";

// Write settings a sponsored send cannot carry. The editor locks them while
// the node would be sponsored, and clears them when Sponsor gas is turned
// back on, so a locked value never changes how the node sends.
export const UNSPONSORED_ONLY_FIELD_KEYS: readonly string[] = [
  "priorityFeeGwei",
  "maxFeeGwei",
];

export const UNSPONSORED_ONLY_ENABLED_WHEN: NonNullable<
  ActionConfigFieldBase["enabledWhen"]
> = {
  when: { computed: "notSponsored", networkField: "network" },
  hint: "Turn off Sponsor gas to set this. Sponsored transactions cannot carry a custom fee.",
  docUrl: SPONSORSHIP_GAS_SETTINGS_DOC_URL,
};
