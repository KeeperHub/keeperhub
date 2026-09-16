"use client";

import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestEditorOnNarrowViewport } from "@/hooks/use-editor-availability";

/**
 * The workflow editor is not offered on a phone.
 *
 * KeeperHub's mobile surface is for monitoring: the runs list, a run's steps and
 * analytics. Authoring, and manual runs with it, stay on a desktop, so this page
 * says so rather than rendering an editor that cannot be driven at 375px.
 *
 * The heading is an `h2` because a deleted workflow renders
 * `Workflow Not Found` as an `h1` on the same page, and two `h1`s in one
 * accessibility tree is a defect rather than a hierarchy.
 *
 * "Use the editor anyway" is the escape hatch
 * `components/mobile-warning-dialog.tsx` used to offer: the gate distinguishes a
 * phone from a narrow window, but a tablet in portrait or a phone with a keyboard
 * attached is a real desktop-shaped session, and WCAG 1.4.4 does not let a
 * viewport size remove content with no way back. The choice is stored, so it
 * survives navigation and reloads.
 */
export function MobileEditorNotice(): React.ReactElement {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
          <Monitor className="size-6 text-muted-foreground" />
        </div>
        <h2 className="font-semibold text-lg">The editor is built for a desktop</h2>
        <p className="text-muted-foreground text-sm">
          Runs, their steps and analytics are all available on this device, from
          the menu. Authoring a workflow needs a larger screen.
        </p>
        <Button
          className="mt-2"
          onClick={requestEditorOnNarrowViewport}
          type="button"
          variant="outline"
        >
          Use the editor anyway
        </Button>
      </div>
    </div>
  );
}
