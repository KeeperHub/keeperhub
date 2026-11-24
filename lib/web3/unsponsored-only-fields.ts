import {
  evaluateShowWhen,
  type ShowWhen,
} from "@/lib/workflow/editor/show-when";
import type { ActionConfigFieldBase } from "@/plugins/registry";

export const SPONSORSHIP_GAS_SETTINGS_DOC_URL =
  "https://docs.keeperhub.com/wallet-management/gas#custom-gas-settings-and-sponsorship";

// Write settings a sponsored send cannot carry. Write Contract locks them
// while the node would be sponsored, and clears them once a change locks
// them, so a locked value never changes how the node sends.
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

/** Whether a config value is set (not unset, null or blank). */
export function isConfigValueSet(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

type FieldAvailability = {
  key: string;
  showWhen?: ShowWhen;
  enabledWhen?: { when: ShowWhen };
};

/** A node's config with its action's (flattened) fields. */
export type NodeFields = {
  config: Record<string, unknown>;
  fields: readonly FieldAvailability[];
};

function isNotSponsoredRule(rule: ShowWhen | undefined): boolean {
  return (
    rule !== undefined && "computed" in rule && rule.computed === "notSponsored"
  );
}

// Shown and accepting input.
function isEditable(node: NodeFields, key: string): boolean {
  const field = node.fields.find((candidate) => candidate.key === key);
  return (
    field !== undefined &&
    evaluateShowWhen(field.showWhen, node.config) &&
    evaluateShowWhen(field.enabledWhen?.when, node.config)
  );
}

/**
 * Clears each set field that only applies while not sponsored, when the
 * change from `before` to `after` locks or hides it (any field: Sponsor gas,
 * Simulate at, network, or the action type). Fields that stay editable, such
 * as Batch Write's fees, are never touched.
 */
export function clearUnsponsoredOnlyFields(
  before: NodeFields,
  after: NodeFields
): Record<string, unknown> {
  let cleared = after.config;
  for (const { key, showWhen, enabledWhen } of after.fields) {
    const appliesWhenNotSponsored =
      isNotSponsoredRule(showWhen) || isNotSponsoredRule(enabledWhen?.when);
    if (
      !(appliesWhenNotSponsored && isConfigValueSet(after.config[key])) ||
      isEditable(after, key) ||
      !isEditable(before, key)
    ) {
      continue;
    }
    cleared = { ...cleared, [key]: "" };
  }
  return cleared;
}
