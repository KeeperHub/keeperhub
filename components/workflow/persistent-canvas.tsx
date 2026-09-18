"use client";

import { usePathname } from "next/navigation";
import { useEditorAvailability } from "@/hooks/use-editor-availability";
import { WorkflowCanvas } from "./workflow-canvas";

export function PersistentCanvas() {
  const pathname = usePathname();
  const editorAvailability = useEditorAvailability();

  // The editor view is desktop-only. A phone gets monitoring (the runs list, a
  // run's steps, analytics), so the canvas is not mounted on one and the workflow
  // page renders the notice that says so instead. Narrow desktop windows are not
  // phones: see use-editor-availability for what the gate tests and why.
  //
  // Anything other than "available" includes the first client render, before the
  // gate has measured. Mounting here and unmounting a frame later is the one way
  // this can leak an editor onto a phone, so it does not mount.
  if (editorAvailability !== "available") {
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
