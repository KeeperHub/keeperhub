"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  previewVersionAtom,
} from "@/lib/workflow/store";

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
  const setPreviewVersion = useSetAtom(previewVersionAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
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
      try {
        const snap = await api.workflow.getById(workflowId, { version });
        setNodes(snap.nodes);
        setEdges(snap.edges);
        setPreviewVersion(version);
        setHasUnsavedChanges(false);
        setVersionParam(version);
      } catch {
        toast.error("Failed to load version");
      }
    },
    [
      workflowId,
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
    try {
      const live = await api.workflow.getById(workflowId);
      setNodes(live.nodes);
      setEdges(live.edges);
    } catch {
      toast.error("Failed to reload the current version");
    } finally {
      setPreviewVersion(null);
      setHasUnsavedChanges(false);
      setVersionParam(null);
    }
  }, [
    workflowId,
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
      try {
        await api.workflow.update(workflowId, { nodes, edges });
        setPreviewVersion(null);
        setHasUnsavedChanges(false);
        setVersionParam(null);
        toast.success(`Restored version ${version}`);
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
