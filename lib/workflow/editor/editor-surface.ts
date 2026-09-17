import type { EditorAvailability } from "@/hooks/use-editor-availability";

/**
 * Which surface the editor route renders.
 *
 * A predicate rather than three inline conditions, because the three of them have
 * to agree and nothing held them together: the desktop overlay, the narrow
 * session's panel and the notice are mutually exclusive, and the width effect that
 * reserves a column for the overlay reads the same pair. Written out at each call
 * site, a change to one is a change to one.
 *
 * `idle` is the first client render, before the gate has measured. It renders none
 * of the three: painting the desktop overlay for a frame and then replacing it with
 * a notice is the flicker this exists to avoid, and painting the notice for a frame
 * on a desktop is the same defect in the other direction.
 *
 * `narrow` is a narrow session on a device that may use the editor (a laptop
 * window at 700px, or a touchscreen laptop whose primary pointer is fine), which is
 * the case that keeps the editor and gets the same in-flow panel a phone-shaped
 * session would have got. `isNarrow` is `useIsMobile`, the width test alone.
 */
export type EditorSurface = "idle" | "desktop" | "narrow" | "notice";

export function editorSurface(
  availability: EditorAvailability,
  isNarrow: boolean
): EditorSurface {
  if (availability === "unknown") {
    return "idle";
  }
  if (availability === "unavailable") {
    return "notice";
  }
  return isNarrow ? "narrow" : "desktop";
}
