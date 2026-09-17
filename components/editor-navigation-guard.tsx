"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import {
  isEditorPath,
  useEditorAvailability,
} from "@/hooks/use-editor-availability";

/**
 * Negates navigation to the workflow editor on a phone.
 *
 * The route itself already answers a phone: `app/workflows/[workflowId]/page.tsx`
 * renders the notice instead of the canvas, so a deep link, a bookmark or a
 * programmatic `router.push` all land on the same explanation. What that leaves
 * is the tap: the editor is linked from the runs table, the earnings and
 * pay-as-you-go tables, a shared execution, the hub and the onboarding checklist,
 * and on a phone every one of those is a dead end one page later. This is the
 * choke point for them, so a new link someone adds tomorrow is covered by being
 * a link rather than by being edited.
 *
 * Anchor navigations only, deliberately. A `router.push` never reaches the DOM as
 * a click, so this cannot be the whole answer, and it does not need to be: the
 * route is the answer for those, and it stays.
 *
 * The listener is capture-phase, so it runs before the row-level handlers that
 * open a table row and before Next's own link handling, and it is only installed
 * while the device is actually a phone: an `unknown` measurement installs
 * nothing, and a desktop installs nothing.
 */
export function EditorNavigationGuard(): null {
  const availability = useEditorAvailability();

  useEffect(() => {
    if (availability !== "unavailable") {
      return;
    }

    const onClick = (event: MouseEvent) => {
      // A modified click is a request for a new tab or window, which on a phone
      // cannot happen anyway, and an already-handled click is not ours to take.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      const anchor =
        target instanceof Element ? target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.origin);
      } catch {
        return;
      }
      if (
        url.origin !== window.location.origin ||
        !isEditorPath(url.pathname)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      // One id, so a second tap replaces the first rather than stacking: the
      // reader has already been told, and the tap is the same question.
      toast.info("The workflow editor needs a desktop", {
        description:
          "Runs, their steps and analytics are available on this device. Open a workflow from a computer, or switch this browser to desktop mode.",
        id: "editor-desktop-only",
      });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [availability]);

  return null;
}
