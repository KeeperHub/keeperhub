"use client";

import { usePathname } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { WorkflowCanvas } from "./workflow-canvas";

export function PersistentCanvas() {
  const pathname = usePathname();
  const isMobile = useIsMobile();

  // The editor view is desktop-only. A phone gets monitoring (the runs list, a
  // run's steps, analytics), so the canvas is not mounted at that width and the
  // workflow page renders the notice that says so instead.
  if (isMobile) {
    return null;
  }

  // Only workflow pages render the canvas. "/" is the scan landing page
  // (app/page.tsx), so the canvas stays unmounted there entirely.
  const showCanvas = pathname.startsWith("/workflows/");

  if (!showCanvas) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-0">
      <WorkflowCanvas />
    </div>
  );
}
