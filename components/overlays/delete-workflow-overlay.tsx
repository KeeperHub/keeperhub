"use client";

import { AlertTriangleIcon } from "lucide-react";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayAction } from "./types";

type DeleteWorkflowWithRunsOverlayProps = {
  overlayId: string;
  workflowName: string;
  onViewRuns: () => void;
  onForceDelete: () => void | Promise<void>;
};

export function DeleteWorkflowWithRunsOverlay({
  overlayId,
  workflowName,
  onViewRuns,
  onForceDelete,
}: DeleteWorkflowWithRunsOverlayProps) {
  const { pop } = useOverlay();

  const actions: OverlayAction[] = [
    {
      label: "Cancel",
      variant: "outline",
      onClick: () => pop(),
    },
    {
      label: "View Runs",
      variant: "default",
      onClick: () => {
        onViewRuns();
        pop();
      },
    },
    {
      label: "Delete Anyway",
      variant: "destructive",
      onClick: async () => {
        await onForceDelete();
        pop();
      },
    },
  ];

  return (
    <Overlay actions={actions} overlayId={overlayId} title="Delete Workflow">
      <div className="flex gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangleIcon className="size-5 text-destructive" />
        </div>
        <p className="text-sm text-muted-foreground">
          &quot;{workflowName}&quot; has execution history. Run history may
          contain sensitive data you want to save before deleting.
        </p>
      </div>
    </Overlay>
  );
}
