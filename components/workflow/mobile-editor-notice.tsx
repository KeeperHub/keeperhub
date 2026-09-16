"use client";

import { Monitor } from "lucide-react";

/**
 * The workflow editor is not offered on a phone.
 *
 * KeeperHub's mobile surface is for monitoring: the runs list, a run's steps and
 * analytics. Authoring, and manual runs with it, stay on a desktop, so this page
 * says so rather than rendering an editor that cannot be driven at 375px. The
 * shell withholds the canvas and the toolbar's run controls at the same width,
 * which is what makes this statement true rather than advisory.
 */
export function MobileEditorNotice(): React.ReactElement {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
          <Monitor className="size-6 text-muted-foreground" />
        </div>
        <h1 className="font-semibold text-lg">Open this on a desktop</h1>
        <p className="text-muted-foreground text-sm">
          The workflow editor is not available on a phone. Runs, their steps and
          analytics are, from the menu.
        </p>
      </div>
    </div>
  );
}
