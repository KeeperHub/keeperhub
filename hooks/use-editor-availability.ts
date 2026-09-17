"use client";

import { useEffect, useState } from "react";

/**
 * Whether the workflow editor is offered at this viewport.
 *
 * The editor is desktop-only by product decision: a phone gets monitoring (the
 * runs list, a run's steps, analytics). Width alone cannot express that, and
 * using it as the test catches the wrong people: a 1366x768 laptop at 200%
 * browser zoom reports about 683 CSS px, a 1440px display at half width reports
 * 720px, and an iPad mini in portrait (744) is a phone by width while an iPhone
 * Pro Max in landscape (932) is not. WCAG 1.4.4 also requires content to stay
 * usable at 200% zoom, so a width gate cannot be the only test.
 *
 * So the gate is a phone test: a narrow viewport AND a device the browser
 * describes as touch-first, which here means a coarse primary pointer or a
 * mobile user agent. Touch points are deliberately not part of it: a touchscreen
 * Windows laptop reports ten of them with `pointer: fine`, because `pointer`
 * describes the primary input and that is the trackpad, so a disjunct on
 * `maxTouchPoints` reads such a laptop as a phone and withdraws the editor from
 * the very zoomed-window case above.
 *
 * There is no override. A phone that wants the editor is told to switch its
 * browser to desktop mode, which is the browser's own escape hatch rather than a
 * second one of ours: `components/mobile-warning-dialog.tsx` gives the same
 * advice, and an in-app override would be a hidden second definition of
 * "desktop" that the route itself does not agree with.
 *
 * The value is three-state because the first client render has not measured yet.
 * `use-mobile.ts` starts at `undefined` and returns `!!undefined`, so a consumer
 * that reads it renders the desktop surface for one frame before the effect runs.
 * For a gate whose job is to keep a Run button off a phone, that frame is the
 * defect. `components/navigation/mobile-nav-sheet.tsx` carries the same guard for
 * the same reason.
 */
export type EditorAvailability = "unknown" | "available" | "unavailable";

const NARROW_VIEWPORT = "(max-width: 767px)";
const COARSE_POINTER = "(pointer: coarse)";
const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile/i;

/**
 * The editor route, and only the editor route.
 *
 * `app/workflows/[workflowId]/page.tsx` is the whole subtree, so a workflow id is
 * the only thing that reaches it. `/workflows` is the list and `/workflows/new`
 * is the create route, both of which a phone may use, so both are excluded by
 * name rather than by a length test.
 */
const EDITOR_PATH = /^\/workflows\/(?!new\/?$)[^/]+\/?$/;

export function isEditorPath(pathname: string): boolean {
  return EDITOR_PATH.test(pathname);
}

export function isNarrowViewport(): boolean {
  return window.matchMedia(NARROW_VIEWPORT).matches;
}

/**
 * True when the device presents itself as a phone or a tablet rather than a
 * narrow window on a desktop. Exported because the desktop-optimised warning has
 * to agree with this gate: a phone that is told to use a desktop, and then told
 * the editor is desktop-only, has been told the same contradictory thing twice.
 */
export function isPhoneLikeViewport(): boolean {
  if (!isNarrowViewport()) {
    return false;
  }
  const coarse = window.matchMedia(COARSE_POINTER).matches;
  return coarse || MOBILE_USER_AGENT.test(navigator.userAgent);
}

function measure(): EditorAvailability {
  return isPhoneLikeViewport() ? "unavailable" : "available";
}

export function useEditorAvailability(): EditorAvailability {
  const [availability, setAvailability] =
    useState<EditorAvailability>("unknown");

  useEffect(() => {
    const update = () => setAvailability(measure());
    update();

    const narrow = window.matchMedia(NARROW_VIEWPORT);
    const coarse = window.matchMedia(COARSE_POINTER);
    narrow.addEventListener("change", update);
    coarse.addEventListener("change", update);

    return () => {
      narrow.removeEventListener("change", update);
      coarse.removeEventListener("change", update);
    };
  }, []);

  return availability;
}
