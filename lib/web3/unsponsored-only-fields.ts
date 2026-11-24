import type { ShowWhen } from "@/lib/workflow/editor/show-when";
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

type NodeFields = {
  config: Record<string, unknown>;
  fields: readonly ActionConfigFieldBase[];
};

// Whether the form shows a field and lets it be edited (the registry's
// isFieldShown && isFieldEnabled, passed in to avoid an import cycle).
type IsEditable = (
  field: ActionConfigFieldBase,
  config: Record<string, unknown>
) => boolean;

function isNotSponsoredRule(rule: ShowWhen | undefined): boolean {
  return (
    rule !== undefined && "computed" in rule && rule.computed === "notSponsored"
  );
}

function editableIn(
  node: NodeFields,
  key: string,
  isEditable: IsEditable
): boolean {
  const field = node.fields.find((candidate) => candidate.key === key);
  return field !== undefined && isEditable(field, node.config);
}

/**
 * Clears each set field that only applies while not sponsored, when the
 * change from `before` to `after` locks or hides it (any field: Sponsor gas,
 * Simulate at, network, or the action type). Fields that stay editable, such
 * as Batch Write's fees, are never touched.
 */
export function clearUnsponsoredOnlyFields(
  before: NodeFields,
  after: NodeFields,
  isEditable: IsEditable
): Record<string, unknown> {
  let cleared = after.config;
  for (const field of after.fields) {
    const appliesWhenNotSponsored =
      isNotSponsoredRule(field.showWhen) ||
      isNotSponsoredRule(field.enabledWhen?.when);
    if (
      !(appliesWhenNotSponsored && isConfigValueSet(after.config[field.key])) ||
      isEditable(field, after.config) ||
      !editableIn(before, field.key, isEditable)
    ) {
      continue;
    }
    cleared = { ...cleared, [field.key]: "" };
  }
  return cleared;
}
