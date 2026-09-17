"use client";

import { useEffect, useState } from "react";

/**
 * Whether the workflow editor is offered on this device.
 *
 * The editor is desktop-only by product decision: a phone gets monitoring (the
 * runs list, a run's steps, analytics). So the gate is the device, not the window:
 * the browser's user agent is the signal, and there is no width term at all.
 *
 * The width term was there, and it was wrong in both directions. A narrow window
 * is not a phone: a 1366x768 laptop at 200% browser zoom reports about 683 CSS px,
 * and WCAG 1.4.4 requires content to stay usable at that zoom, so a gate that
 * withdraws the editor for being narrow withdraws it from a desktop. It also missed
 * the case the round-6 review measured: an iPhone Pro Max in landscape is 932px
 * wide, so a width term read it as a desktop and gave it the full editor and a live
 * Run button, while the decision is that the editor is not available to mobile
 * users at all.
 *
 * A user agent is a device signal rather than a viewport signal, so a phone is a
 * phone at every width and in both orientations, and nothing is ever removed
 * because of viewport size. It also makes the escape hatch work by construction: a
 * phone that switches its browser to desktop mode reports a desktop user agent and
 * gets the editor. That is the browser's own answer rather than a second one of
 * ours, and it is the advice `components/mobile-warning-dialog.tsx` gives.
 *
 * There is no override and no listener. The value is measured once, because a user
 * agent does not change without a reload, which leaves rotation and window resizing
 * with nothing to re-measure. The value is still three-state, because the first
 * client render has not measured yet: `use-mobile.ts` starts at `undefined` and
 * returns `!!undefined`, so a consumer that reads it paints the desktop surface for
 * one frame before its effect runs. For a gate whose job is to keep a Run button
 * off a phone, that frame is the defect.
 */
export type EditorAvailability = "unknown" | "available" | "unavailable";

const NARROW_VIEWPORT = "(max-width: 767px)";
const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile/i;

/**
 * Window width alone, for the two places that need it and not the gate.
 *
 * `components/mobile-warning-dialog.tsx` warns a narrow desktop window that the app
 * is desktop-optimised, which is a statement about the window rather than about the
 * device.
 */
export function isNarrowViewport(): boolean {
  return window.matchMedia(NARROW_VIEWPORT).matches;
}

/**
 * True when the browser describes itself as a mobile browser.
 *
 * Exported because the warning dialog has to agree with this gate: on a phone the
 * editor is gone and the notice says so, so a phone must not also be told that the
 * app is desktop-optimised and that it should come back on a desktop.
 */
export function isMobileBrowser(): boolean {
  return MOBILE_USER_AGENT.test(navigator.userAgent);
}

function measure(): EditorAvailability {
  return isMobileBrowser() ? "unavailable" : "available";
}

export function useEditorAvailability(): EditorAvailability {
  const [availability, setAvailability] =
    useState<EditorAvailability>("unknown");

  useEffect(() => {
    setAvailability(measure());
  }, []);

  return availability;
}
