/**
 * The editor route's three surfaces, pinned.
 *
 * Per the round-6 review: `NodeConfigPanel` and `rightPanelWidth` appeared nowhere
 * in `tests/`, so the condition that decides whether the panel is rendered, and the
 * effect that reserves its column, were both unpinned. They now read one predicate
 * and this holds that predicate at every combination.
 */
import { describe, expect, it } from "vitest";
import { editorSurface } from "@/lib/workflow/editor/editor-surface";

describe("editorSurface", () => {
  it("renders the notice on a phone and nothing else", () => {
    // Either width, because a phone in landscape is still a phone: the gate, not
    // this predicate, is what decides that.
    expect(editorSurface("unavailable", true)).toBe("notice");
    expect(editorSurface("unavailable", false)).toBe("notice");
  });

  it("renders the overlay on a desktop-shaped session", () => {
    expect(editorSurface("available", false)).toBe("desktop");
  });

  it("renders the in-flow panel for a narrow session that keeps the editor", () => {
    // A laptop window at 700px, or a touchscreen laptop whose primary pointer is
    // fine. The overlay is `md:flex` at the content level, so painting it here
    // would put an opaque empty strip over the canvas.
    expect(editorSurface("available", true)).toBe("narrow");
  });

  it("renders none of them before the gate has measured", () => {
    // The first client render. Painting the overlay for a frame and then replacing
    // it with a notice is the flicker this exists to avoid, and painting the notice
    // for a frame on a desktop is the same defect the other way round.
    expect(editorSurface("unknown", true)).toBe("idle");
    expect(editorSurface("unknown", false)).toBe("idle");
  });

  it("never renders two surfaces at once", () => {
    const seen = new Set<string>();
    for (const availability of [
      "unknown",
      "available",
      "unavailable",
    ] as const) {
      for (const narrow of [true, false]) {
        seen.add(editorSurface(availability, narrow));
      }
    }
    // Six combinations, four outcomes, and the two that repeat are the notice and
    // idle, which are the ones the pair of widths cannot distinguish.
    expect(seen).toEqual(new Set(["idle", "desktop", "narrow", "notice"]));
  });

  it("gives the width effect the same answer as the overlay", () => {
    // The effect reserves the overlay's column when `surface === "desktop"`. On a
    // phone the answer is `notice`, so the canvas keeps the full width, and on a
    // narrow session it is `narrow`, where the panel is in flow and reserves no
    // column either.
    expect(editorSurface("unavailable", false)).not.toBe("desktop");
    expect(editorSurface("available", true)).not.toBe("desktop");
    expect(editorSurface("available", false)).toBe("desktop");
  });
});
