"use client";

import { useAtomValue } from "jotai";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { currentWorkflowIdAtom, previewVersionAtom } from "@/lib/workflow/store";
import { useVersionPreview } from "@/lib/workflow/use-version-preview";

/**
 * Read-only banner shown while the canvas previews a historical version (set
 * from the version-history panel's "View on canvas", or by opening a
 * `?version=` URL). Styled as the app's segmented navbar pill. Restore lives
 * here only -- the panel no longer duplicates it. Autosave stays suppressed
 * via previewVersionAtom, so the live workflow is untouched until restore.
 */
export function VersionPreviewBanner(): React.ReactElement | null {
  const previewVersion = useAtomValue(previewVersionAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const { exitPreview, restore } = useVersionPreview();
  const [busy, setBusy] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);

  // Resolve the workflow's latest version so previewing it presents as the live
  // "Current version" (green) with Restore hidden -- restoring the current
  // version is a no-op.
  useEffect(() => {
    if (!workflowId) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.workflow.getHistory(workflowId, {
          page: 1,
          limit: 1,
        });
        if (!cancelled) {
          setCurrentVersion(res.items[0]?.version ?? null);
        }
      } catch {
        // Best-effort: without it Restore simply stays available, which is safe.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  if (previewVersion === null || !workflowId) {
    return null;
  }

  const isCurrent = previewVersion === currentVersion;

  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="-translate-x-1/2 fixed top-[calc(var(--header-height,60px)+12px)] left-1/2 z-50 flex h-9 items-center rounded-md border bg-secondary text-secondary-foreground shadow-md">
      <span className="flex h-full items-center gap-1.5 rounded-l-md px-3 font-medium text-sm">
        <Eye
          className={`size-4 ${isCurrent ? "text-keeperhub-green" : "text-amber-400"}`}
        />
        {isCurrent ? "Current version" : `Viewing version ${previewVersion}`}
      </span>
      <div className="h-5 w-px bg-border" />
      <button
        className={`flex h-full items-center px-3 font-medium text-sm transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5 ${
          isCurrent ? "rounded-r-md" : ""
        }`}
        disabled={busy}
        onClick={run(exitPreview)}
        type="button"
      >
        Exit preview
      </button>
      {!isCurrent && (
        <>
          <div className="h-5 w-px bg-border" />
          <button
            className="flex h-full items-center rounded-r-md px-3 font-medium text-sm transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            disabled={busy}
            onClick={run(() => restore(previewVersion))}
            type="button"
          >
            Restore this version
          </button>
        </>
      )}
    </div>
  );
}
