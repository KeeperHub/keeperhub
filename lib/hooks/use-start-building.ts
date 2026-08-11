"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import {
  edgesAtom,
  editorTourRequestedAtom,
  isTransitioningFromHomepageAtom,
  nodesAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

function createDefaultNodes(): {
  nodes: WorkflowNode[];
  edges: { id: string; source: string; target: string; type: string }[];
} {
  const triggerId = nanoid();
  const actionId = nanoid();
  const edgeId = nanoid();

  const triggerNode: WorkflowNode = {
    id: triggerId,
    type: "trigger" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "",
      description: "",
      type: "trigger" as const,
      config: { triggerType: "Manual" },
      status: "idle" as const,
    },
  };

  const actionNode: WorkflowNode = {
    id: actionId,
    type: "action" as const,
    position: { x: 272, y: 0 },
    selected: true,
    data: {
      label: "",
      description: "",
      type: "action" as const,
      config: {},
      status: "idle" as const,
    },
  };

  const edge = {
    id: edgeId,
    source: triggerId,
    target: actionId,
    type: "animated",
  };

  return { nodes: [triggerNode, actionNode], edges: [edge] };
}

/**
 * "Start building" entry point shared by the homepage canvas placeholder and
 * the scan landing hero: seeds the default trigger+action scaffold, creates
 * the workflow, and navigates into the editor. Anonymous users are capped at
 * one workflow -- they are dropped onto their most recent one instead.
 *
 * Extracted from app/page.tsx so the scan landing can offer the identical
 * flow without the canvas being mounted.
 */
export function useStartBuilding(): { startBuilding: () => Promise<void> } {
  const router = useRouter();
  const { data: session } = useSession();
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setIsTransitioningFromHomepage = useSetAtom(
    isTransitioningFromHomepageAtom
  );
  const setTourRequested = useSetAtom(editorTourRequestedAtom);
  const tourRequested = useAtomValue(editorTourRequestedAtom);
  const hasCreatedWorkflowRef = useRef(false);

  // Helper to create anonymous session if needed
  const ensureSession = useCallback(async () => {
    if (!session) {
      await authClient.signIn.anonymous();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, [session]);

  // If the user already has workflows, navigate to the most recent one instead
  // of creating a new one. Anonymous users are limited to a single workflow.
  const startBuilding = useCallback(async () => {
    if (hasCreatedWorkflowRef.current) {
      return;
    }
    hasCreatedWorkflowRef.current = true;

    try {
      await ensureSession();

      if (isAnonymousUser(session?.user)) {
        const existing = await api.workflow.getAll();
        if (existing.length > 0) {
          const latest = existing.sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )[0];
          setIsTransitioningFromHomepage(true);
          router.replace(`/workflows/${latest.id}`);
          return;
        }
      }

      const { nodes: defaultNodes, edges: defaultEdges } = createDefaultNodes();
      setNodes(defaultNodes);
      setEdges(defaultEdges);

      const newWorkflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: "",
        nodes: defaultNodes,
        edges: defaultEdges,
      });

      refetchSidebar();
      sessionStorage.setItem("animate-sidebar", "true");
      setIsTransitioningFromHomepage(true);
      router.replace(`/workflows/${newWorkflow.id}`);
    } catch (error) {
      console.error("Failed to create workflow:", error);
      toast.error("Failed to create workflow");
      hasCreatedWorkflowRef.current = false;
      if (tourRequested) {
        setTourRequested(false);
      }
    }
  }, [
    session,
    setNodes,
    setEdges,
    ensureSession,
    router,
    setIsTransitioningFromHomepage,
    setTourRequested,
    tourRequested,
  ]);

  return { startBuilding };
}
