"use client";

import { useCallback, useState } from "react";

export type RenameDraft = {
  value: string | null;
  editing: boolean;
  saving: boolean;
  set: (next: string) => void;
  start: () => void;
  cancel: () => void;
  commit: () => Promise<void>;
};

/** Inline rename state for a single row: start, edit, commit or cancel. */
export function useRenameDraft(
  current: string,
  onCommit: (next: string) => Promise<boolean>
): RenameDraft {
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const cancel = useCallback((): void => {
    setValue(null);
  }, []);

  const commit = useCallback(async (): Promise<void> => {
    const next = value?.trim() ?? "";
    if (!next || next === current) {
      setValue(null);
      return;
    }
    setSaving(true);
    const ok = await onCommit(next);
    setSaving(false);
    if (ok) {
      setValue(null);
    }
  }, [value, current, onCommit]);

  return {
    cancel,
    commit,
    editing: value !== null,
    saving,
    set: setValue,
    start: () => setValue(current),
    value,
  };
}
