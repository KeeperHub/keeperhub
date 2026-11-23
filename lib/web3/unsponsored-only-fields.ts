import type { ShowWhen } from "@/lib/workflow/editor/show-when";

// Write settings a sponsored send cannot carry. The editor shows them only
// while the node would pay its own gas, and clears them when Sponsor gas is
// turned back on, so a hidden value never changes how the node sends.
export const UNSPONSORED_ONLY_FIELD_KEYS: readonly string[] = [
  "priorityFeeGwei",
];

export const UNSPONSORED_ONLY_SHOW_WHEN: ShowWhen = {
  computed: "notSponsored",
  networkField: "network",
};
