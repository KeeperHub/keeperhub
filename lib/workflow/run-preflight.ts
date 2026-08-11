/**
 * Persist unsaved editor state before a manual run.
 *
 * The execute endpoint runs the stored workflow definition, while config
 * edits sit in a debounced autosave. Running without flushing executes a
 * stale definition - freshly entered node config (e.g. network/address)
 * silently never reaches the steps. Version previews are excluded: the
 * canvas then shows a historical snapshot that must not overwrite the draft.
 *
 * Returns true when it is safe to execute, false when the save failed and
 * the run must be aborted.
 */
export async function ensureSavedBeforeRun(params: {
  hasUnsavedChanges: boolean;
  isPreviewingVersion: boolean;
  save: () => Promise<boolean>;
}): Promise<boolean> {
  if (!params.hasUnsavedChanges || params.isPreviewingVersion) {
    return true;
  }
  return await params.save();
}
