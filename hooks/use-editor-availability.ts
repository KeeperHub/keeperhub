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
 * So the gate is a phone test: a narrow viewport AND a device that reports
 * itself as touch-first (coarse pointer, touch points, or a mobile user agent).
 * A narrow desktop window keeps the editor, and a phone user who wants it anyway
 * can say so once with `requestEditorOnNarrowViewport`, which is the escape hatch
 * `components/mobile-warning-dialog.tsx` already offered with its Continue Anyway
 * button.
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

/** Stored when a user on a narrow touch device asks for the editor anyway. */
export const EDITOR_OVERRIDE_KEY = "keeperhub-editor-on-narrow-viewport";

const OVERRIDE_EVENT = "keeperhub-editor-override";

export function isNarrowViewport(): boolean {
  return window.matchMedia(NARROW_VIEWPORT).matches;
}

/**
 * True when the device presents itself as a phone or a tablet rather than a
 * narrow window on a desktop. Exported because the desktop-optimised warning
 * has to agree with this gate: a phone that is told to use a desktop, and then
 * told the editor is desktop-only, has been told the same contradictory thing
 * twice.
 */
export function isPhoneLikeViewport(): boolean {
  if (!isNarrowViewport()) {
    return false;
  }
  const coarse = window.matchMedia(COARSE_POINTER).matches;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  return coarse || touch || MOBILE_USER_AGENT.test(navigator.userAgent);
}

export function prefersEditorOnNarrowViewport(): boolean {
  try {
    // window.localStorage rather than the bare global: Node defines a
    // `localStorage` global of its own that is unusable without a flag, and it
    // shadows the DOM one under a jsdom test environment.
    return window.localStorage.getItem(EDITOR_OVERRIDE_KEY) === "1";
  } catch {
    // Storage blocked (Safari private mode, lockdown). Not an override.
    return false;
  }
}

/** Called by the notice's escape hatch: this device wants the editor. */
export function requestEditorOnNarrowViewport(): void {
  try {
    window.localStorage.setItem(EDITOR_OVERRIDE_KEY, "1");
  } catch {
    // Storage blocked: the override lasts for this page only.
  }
  window.dispatchEvent(new Event(OVERRIDE_EVENT));
}

function measure(): EditorAvailability {
  if (!isPhoneLikeViewport() || prefersEditorOnNarrowViewport()) {
    return "available";
  }
  return "unavailable";
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
    window.addEventListener(OVERRIDE_EVENT, update);

    return () => {
      narrow.removeEventListener("change", update);
      coarse.removeEventListener("change", update);
      window.removeEventListener(OVERRIDE_EVENT, update);
    };
  }, []);

  return availability;
}
