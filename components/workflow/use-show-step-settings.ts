"use client";

import { useReactFlow } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { usePathname } from "next/navigation";
import { useCallback } from "react";
import { ConfigurationOverlay } from "@/components/overlays/configuration-overlay";
import { useOverlayActions } from "@/components/overlays/overlay-provider";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  isPanelAnimatingAtom,
  isSidebarCollapsedAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

// Steps are 192px square (w-48 h-48).
const STEP_SIZE = 192;

/**
 * Shows the selected step's settings: the side panel from md up, the
 * Configuration sheet on phones, which have no side panel. Pass a step that
 * was just added to centre it, so it is in view once the sheet is closed.
 */
export function useShowStepSettings(): (newStep?: WorkflowNode) => void {
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const { open } = useOverlayActions();
  const { getZoom, setCenter } = useReactFlow();
  const isSidebarCollapsed = useAtomValue(isSidebarCollapsedAtom);
  const setSidebarCollapsed = useSetAtom(isSidebarCollapsedAtom);
  const setIsPanelAnimating = useSetAtom(isPanelAnimatingAtom);

  return useCallback(
    (newStep?: WorkflowNode) => {
      if (!isMobile) {
        if (isSidebarCollapsed) {
          setIsPanelAnimating(true);
          setSidebarCollapsed(false);
          setTimeout(() => setIsPanelAnimating(false), 350);
        }
        return;
      }
      // The home page canvas has no settings to show.
      if (!pathname.startsWith("/workflows/")) {
        return;
      }
      if (newStep) {
        setCenter(
          newStep.position.x + STEP_SIZE / 2,
          newStep.position.y + STEP_SIZE / 2,
          { zoom: getZoom(), duration: 300 }
        );
      }
      open(ConfigurationOverlay, {}, { title: "Configuration" });
    },
    [
      isMobile,
      isSidebarCollapsed,
      setIsPanelAnimating,
      setSidebarCollapsed,
      pathname,
      setCenter,
      getZoom,
      open,
    ]
  );
}
