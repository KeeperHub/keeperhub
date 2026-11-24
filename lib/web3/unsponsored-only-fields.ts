import {
  type ShowWhen,
  wouldBeSponsored,
} from "@/lib/workflow/editor/show-when";

// Write settings a sponsored send cannot carry. Write Contract shows them only
// while the node would pay its own gas, and clears them once a change makes
// it sponsored again, so a hidden value never changes how the node sends.
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

/**
 * Clears each set field the action shows only while not sponsored, when the
 * change from `before` to `after` makes the node sponsored (any field:
 * Sponsor gas, Simulate at, network...). Fields that always show, such as
 * Batch Write's fees, are never touched.
 */
export function clearUnsponsoredOnlyFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly FieldVisibility[]
): Record<string, unknown> {
  let cleared = after;
  for (const { key, showWhen } of fields) {
    if (
      showWhen === undefined ||
      !("computed" in showWhen) ||
      showWhen.computed !== "notSponsored" ||
      !isConfigValueSet(after[key]) ||
      wouldBeSponsored(before, showWhen.networkField) ||
      !wouldBeSponsored(after, showWhen.networkField)
    ) {
      continue;
    }
    cleared = { ...cleared, [key]: "" };
  }
  return cleared;
}
