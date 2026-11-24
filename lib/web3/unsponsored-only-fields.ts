import {
  evaluateShowWhen,
  type ShowWhen,
} from "@/lib/workflow/editor/show-when";

// Write settings a sponsored send cannot carry. Write Contract shows them only
// while the node would pay its own gas, and clears them once a change hides
// them, so a hidden value never changes how the node sends.
export const UNSPONSORED_ONLY_FIELD_KEYS: readonly string[] = [
  "priorityFeeGwei",
  "maxFeeGwei",
];

export const UNSPONSORED_ONLY_SHOW_WHEN: ShowWhen = {
  computed: "notSponsored",
  networkField: "network",
};

/** Whether a config value is set (not unset, null or blank). */
export function isConfigValueSet(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

type FieldVisibility = { key: string; showWhen?: ShowWhen };

/** A node's config with its action's (flattened) fields. */
export type NodeFields = {
  config: Record<string, unknown>;
  fields: readonly FieldVisibility[];
};

function isShown(node: NodeFields, key: string): boolean {
  const field = node.fields.find((candidate) => candidate.key === key);
  return field !== undefined && evaluateShowWhen(field.showWhen, node.config);
}

/**
 * Clears each set field that is shown only while not sponsored, when the
 * change from `before` to `after` hides it (any field: Sponsor gas, Simulate
 * at, network, or the action type). Fields that stay shown, such as Batch
 * Write's fees, are never touched.
 */
export function clearUnsponsoredOnlyFields(
  before: NodeFields,
  after: NodeFields
): Record<string, unknown> {
  let cleared = after.config;
  for (const { key, showWhen } of after.fields) {
    if (
      showWhen === undefined ||
      !("computed" in showWhen) ||
      showWhen.computed !== "notSponsored" ||
      !isConfigValueSet(after.config[key]) ||
      isShown(after, key) ||
      !isShown(before, key)
    ) {
      continue;
    }
    cleared = { ...cleared, [key]: "" };
  }
  return cleared;
}
