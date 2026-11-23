import { useEffect } from "react";

// How many mounted components need the variables, so the last one to unmount
// removes them.
let users = 0;

/**
 * While mounted, mirrors the visual viewport (the part of the page the
 * on-screen keyboard leaves visible) into --visual-viewport-height and
 * --visual-viewport-top on <html>, for the keyboard-safe-window utility in
 * globals.css. dvh and vh keep the full screen height when the keyboard
 * opens; the visual viewport shrinks to what is left above it.
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    const root = document.documentElement;
    const update = (): void => {
      root.style.setProperty(
        "--visual-viewport-height",
        `${viewport.height}px`
      );
      root.style.setProperty(
        "--visual-viewport-top",
        `${viewport.offsetTop}px`
      );
    };

    users += 1;
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      users -= 1;
      if (users === 0) {
        root.style.removeProperty("--visual-viewport-height");
        root.style.removeProperty("--visual-viewport-top");
      }
    };
  }, []);
}
