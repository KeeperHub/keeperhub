"use client";

import { useReactFlow } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { usePathname } from "next/navigation";
import { useCallback } from "react";
import { ConfigurationOverlay } from "@/components/overlays/configuration-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  isPanelAnimatingAtom,
  isSidebarCollapsedAtom,
  propertiesPanelActiveTabAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

// Steps are 192px square (w-48 h-48).
const STEP_SIZE = 192;

/**
 * Shows the selected step's settings: the side panel from md up, the
 * Configuration sheet on phones, which have no side panel. Pass a step that
 * was just added to bring it into view on a phone.
 */
export function useShowStepSettings(): (newStep?: WorkflowNode) => void {
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const { open, stack } = useOverlay();
  const { getZoom, setCenter } = useReactFlow();
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const isSidebarCollapsed = useAtomValue(isSidebarCollapsedAtom);
  const setSidebarCollapsed = useSetAtom(isSidebarCollapsedAtom);
  const setIsPanelAnimating = useSetAtom(isPanelAnimatingAtom);
  const sheetOpen = stack.at(-1)?.component === ConfigurationOverlay;

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
      // Unlike the side panel, the sheet is not already showing a tab the
      // user chose, so it opens on the step itself.
      setActiveTab("properties");
      // Already open (a double tap): it follows the selection by itself.
      if (!sheetOpen) {
        open(ConfigurationOverlay, {}, { title: "Step settings" });
      }
    },
    [
      isMobile,
      isSidebarCollapsed,
      setIsPanelAnimating,
      setSidebarCollapsed,
      pathname,
      setCenter,
      getZoom,
      setActiveTab,
      sheetOpen,
      open,
    ]
  );
}
