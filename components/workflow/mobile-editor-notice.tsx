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
 * Composed the way `components/analytics/empty-state.tsx` composes the same
 * situation, deliberately rather than approximately: the same centred icon tile
 * at `size-20 rounded-2xl` holding a `size-10` glyph, the same `gap-6` between
 * blocks, the same `space-y-2` group at `text-xl font-semibold tracking-tight`
 * and `max-w-sm text-sm text-muted-foreground`, and one primary button. Two
 * empty states for one product should not be two designs. The one wrapper this
 * adds is `pointer-events-auto`; see the return.
 *
 * The heading is an `h2` because a deleted workflow renders `Workflow Not Found`
 * as an `h1` on the same page, and two `h1`s in one accessibility tree is a
 * defect rather than a hierarchy.
 *
 * "Use the editor anyway" is the escape hatch, so it is the state's one action
 * rather than a footnote: the gate distinguishes a phone from a narrow window,
 * but a tablet in portrait or a phone with a keyboard attached is a real
 * desktop-shaped session, and WCAG 1.4.4 does not let a viewport size remove
 * content with no way back. The choice lasts the browser session, so the phone
 * surface returns when the tab closes.
 */
export function MobileEditorNotice(): React.ReactElement {
  return (
    // `components/layout-content.tsx` wraps every route's children in
    // `pointer-events-none`, so anything interactive names the class back. It
    // matters more here than anywhere else on the page: this button is the only
    // way out of the withdrawn editor, which is the whole argument for it
    // existing. The wrapper is outer rather than merged into the composition
    // below so the class list shared with the analytics empty state stays
    // identical, which the test asserts.
    <div className="pointer-events-auto">
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
        <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
          <Monitor className="size-10 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-semibold tracking-tight">
            The editor is built for a desktop
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Runs, their steps and analytics are all available on this device,
            from the menu. Authoring a workflow needs a larger screen.
          </p>
        </div>

        <Button onClick={requestEditorOnNarrowViewport} type="button">
          Use the editor anyway
        </Button>
      </div>
    </div>
  );
}
