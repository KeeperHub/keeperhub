// No imports: shared by the canvas store, the save sanitizer and the export schema.

/** The node states a saved workflow may hold; a run view's own states are never saved. */
const SAVED_NODE_STATUSES = ["idle", "running", "success", "error"] as const;

type SavedNodeStatus = (typeof SAVED_NODE_STATUSES)[number];

export function isSavedNodeStatus(value: unknown): value is SavedNodeStatus {
  return (
    typeof value === "string" &&
    (SAVED_NODE_STATUSES as readonly string[]).includes(value)
  );
}
