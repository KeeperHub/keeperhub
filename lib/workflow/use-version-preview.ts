"use client";

import { useAtomValue, useSetAtom, useStore } from "jotai";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  type PreviewRequestStatus,
  previewRequestsAtom,
  previewVersionAtom,
  propertiesPanelActiveTabAtom,
} from "@/lib/workflow/store";

// Bumped by every preview and exit. A canvas load only applies while it is
// still the latest request, so a version that finishes loading after the user
// left History (or started another preview) cannot land on the canvas. Shared
// across hook instances because the panel, banner and page each call the hook.
let latestCanvasRequest = 0;

/**
 * Single source of truth for previewing a historical workflow version on the
 * canvas. Owns the `previewVersionAtom` <-> `?version=` URL sync so a preview
 * is shareable/reopenable by URL, and is reused by the version-history panel
 * (View on canvas), the preview banner (Exit/Restore), and the editor's
 * load-from-URL effect. Autosave stays suppressed while `previewVersionAtom`
 * is set, so a preview never clobbers the live workflow.
 */
export function useVersionPreview() {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const store = useStore();
  const setPreviewVersion = useSetAtom(previewVersionAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const setPreviewRequests = useSetAtom(previewRequestsAtom);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setVersionParam = useCallback(
    (version: number | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (version === null) {
        params.delete("version");
      } else {
        params.set("version", String(version));
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const preview = useCallback(
    async (version: number) => {
      if (!workflowId) {
        return;
      }
      latestCanvasRequest += 1;
      const request = latestCanvasRequest;
      setPreviewRequests((entries) => [
        ...entries.filter((entry) => entry.status === "pending"),
        { request, version, status: "pending" },
      ]);
      // Updates only this request's entry, so a late response cannot overwrite
      // what a newer preview reported.
      const settle = (status: PreviewRequestStatus) => {
        setPreviewRequests((entries) =>
          entries.map((entry) =>
            entry.request === request ? { ...entry, status } : entry
          )
        );
      };
      try {
        const snap = await api.workflow.getById(workflowId, { version });
        if (request !== latestCanvasRequest) {
          settle("discarded");
          return;
        }
        setNodes(snap.nodes);
        setEdges(snap.edges);
        setPreviewVersion(version);
        setHasUnsavedChanges(false);
        setVersionParam(version);
        settle("applied");
      } catch {
        if (request === latestCanvasRequest) {
          settle("failed");
          toast.error("Failed to load version");
        } else {
          settle("discarded");
        }
      }
    },
    [
      workflowId,
      setPreviewRequests,
      setNodes,
      setEdges,
      setPreviewVersion,
      setHasUnsavedChanges,
      setVersionParam,
    ]
  );

  const exitPreview = useCallback(async () => {
    if (!workflowId) {
      return;
    }
    // Cancels a preview that is still loading.
    latestCanvasRequest += 1;
    const request = latestCanvasRequest;
    // Nothing is previewed, so the canvas already holds the live workflow.
    // Reloading it anyway would replace the nodes and drop the selection; only
    // a leftover ?version= (a pending preview, or ?version=current) needs
    // clearing.
    if (store.get(previewVersionAtom) === null) {
      if (searchParams?.has("version")) {
        setVersionParam(null);
      }
      return;
    }
    try {
      const live = await api.workflow.getById(workflowId);
      if (request !== latestCanvasRequest) {
        return;
      }
      setNodes(live.nodes);
      setEdges(live.edges);
      setPreviewVersion(null);
      setHasUnsavedChanges(false);
      setVersionParam(null);
    } catch {
      // Stay in the preview: leaving it would put the old snapshot's nodes on
      // the canvas as if they were the live workflow. A superseded reload has
      // nothing to report.
      if (request === latestCanvasRequest) {
        toast.error("Failed to reload the current version");
      }
    }
  }, [
    workflowId,
    store,
    searchParams,
    setNodes,
    setEdges,
    setPreviewVersion,
    setHasUnsavedChanges,
    setVersionParam,
  ]);

  // Restore the previewed snapshot (the current canvas) as a new live edit.
  const restore = useCallback(
    async (version: number) => {
      if (!workflowId) {
        return;
      }
      // Cancels a preview that is still loading, so it cannot land after the
      // restore.
      latestCanvasRequest += 1;
      const request = latestCanvasRequest;
      try {
        await api.workflow.update(workflowId, { nodes, edges });
        toast.success(`Restored version ${version}`);
        // A preview started while saving owns the canvas now; leave it.
        if (request !== latestCanvasRequest) {
          return;
        }
        setPreviewVersion(null);
        setHasUnsavedChanges(false);
        setVersionParam(null);
      } catch {
        toast.error("Failed to restore version");
      }
    },
    [
      workflowId,
      nodes,
      edges,
      setPreviewVersion,
      setHasUnsavedChanges,
      setVersionParam,
    ]
  );

  return { preview, exitPreview, restore };
}

/**
 * Drops the canvas preview when the properties panel leaves the History tab,
 * whichever control changed the tab (a tab click, a node double-click, the
 * mobile overlay). Watching the tab itself keeps this independent of when the
 * History panel happens to mount or unmount. Call it once, from the editor.
 */
export function useExitPreviewOnLeavingHistory(): void {
  const activeTab = useAtomValue(propertiesPanelActiveTabAtom);
  const { exitPreview } = useVersionPreview();
  const previousTab = useRef(activeTab);

  useEffect(() => {
    const leftHistory =
      previousTab.current === "history" && activeTab !== "history";
    previousTab.current = activeTab;
    if (leftHistory) {
      exitPreview().catch(() => {
        // Best-effort: a failure here must not break tab switching.
      });
    }
  }, [activeTab, exitPreview]);
}
