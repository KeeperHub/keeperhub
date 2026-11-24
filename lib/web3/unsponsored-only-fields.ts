import {
  type ShowWhen,
  wouldBeSponsored,
} from "@/lib/workflow/editor/show-when";

// Write settings a sponsored send cannot carry. The editor shows them only
// while the node would pay its own gas, and clears them when Sponsor gas is
// turned back on, so a hidden value never changes how the node sends.
export const UNSPONSORED_ONLY_FIELD_KEYS: readonly string[] = [
  "priorityFeeGwei",
  "maxFeeGwei",
];

export const UNSPONSORED_ONLY_SHOW_WHEN: ShowWhen = {
  computed: "notSponsored",
  networkField: "network",
};

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/**
 * Clears the unsponsored-only settings when a config change makes the node
 * sponsored again (any field: Sponsor gas, Simulate at, network...), so a
 * hidden fee can never keep the node off the sponsored route unseen.
 */
export function clearUnsponsoredOnlyFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> {
  if (
    wouldBeSponsored(before, "network") ||
    !wouldBeSponsored(after, "network") ||
    !UNSPONSORED_ONLY_FIELD_KEYS.some((key) => isSet(after[key]))
  ) {
    return after;
  }
  const cleared = { ...after };
  for (const key of UNSPONSORED_ONLY_FIELD_KEYS) {
    if (isSet(cleared[key])) {
      cleared[key] = "";
    }
  }
  return cleared;
}
