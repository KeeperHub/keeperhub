// Per workflow id, the trigger config last seen saved in the editor, and
// when: a counter, so a list fetch can tell what was recorded after it began.
export type SavedTriggers = Readonly<
  Record<string, { config: Record<string, unknown> | undefined; seq: number }>
>;

/**
 * Records the open workflow's saved trigger. Unchanged when the same config
 * is already recorded, so re-renders do not churn the state.
 */
export function recordSavedTrigger(
  saved: SavedTriggers,
  workflowId: string,
  config: Record<string, unknown> | undefined,
  seq: number
): SavedTriggers {
  if (workflowId in saved && saved[workflowId].config === config) {
    return saved;
  }
  return { ...saved, [workflowId]: { config, seq } };
}

/**
 * What a list fetch that began at `seq` leaves: entries recorded after it
 * began, which its reply may not include yet. Everything older is in the
 * reply. Unchanged when nothing is dropped.
 */
export function dropSavedTriggersUpTo(
  saved: SavedTriggers,
  seq: number
): SavedTriggers {
  const kept = Object.entries(saved).filter(([, entry]) => entry.seq > seq);
  return kept.length === Object.keys(saved).length
    ? saved
    : Object.fromEntries(kept);
}
