"use client";

import { Monitor } from "lucide-react";

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
 * blocks, and the same `space-y-2` group at `text-xl font-semibold
 * tracking-tight` over `max-w-sm text-sm text-muted-foreground`. Two empty states
 * for one product should not be two designs, and the test reads that sibling file
 * off disk so the shared classes cannot drift apart quietly.
 *
 * The heading is an `h2` because a deleted workflow renders `Workflow Not Found`
 * as an `h1` on the same page, and two `h1`s in one accessibility tree is a
 * defect rather than a hierarchy.
 *
 * It carries no action, which is the difference between this and the analytics
 * empty state: there is nothing to press. Switching the browser to desktop mode
 * is the way through, and that is a browser setting rather than something a page
 * can do for the reader, so the copy names it instead of offering a control that
 * would only be reachable on the devices this gate had to measure carefully to
 * exclude.
 */
export function MobileEditorNotice(): React.ReactElement {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
        <Monitor className="size-10 text-muted-foreground" />
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          The editor is built for a desktop
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Runs, their steps and analytics are all available on this device, from
          the menu. To author a workflow, open this page from a computer, or
          switch this browser to desktop mode.
        </p>
      </div>
    </div>
  );
}
