"use client";

import { type RefObject, useEffect } from "react";

// Upward travel that opens the sheet full screen; downward travel at the top
// of the content that brings it back.
const EXPAND_DISTANCE = 16;
const COLLAPSE_DISTANCE = 48;
// A wheel flick that scrolls back to the top must pause before collapsing.
const WHEEL_SETTLE_MS = 300;

/** Whether anything between target and root is scrolled down from its top. */
function isScrolledDown(
  target: EventTarget | null,
  root: HTMLElement
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node.scrollTop > 0) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * Swipe or scroll up on a bottom sheet to open it full screen; swipe or scroll
 * down while its content is at the top to bring it back to its own height.
 */
export function useSheetExpand(
  sheet: HTMLElement | null,
  // Read in the listeners, so they need not re-attach on every switch.
  expandedRef: RefObject<boolean>,
  setExpanded: (expanded: boolean) => void
): void {
  useEffect(() => {
    if (!sheet) {
      return;
    }
    let start: { x: number; y: number; scrolled: boolean } | null = null;
    let lastScrolledWheel = 0;

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch
          ? {
              x: touch.clientX,
              y: touch.clientY,
              scrolled: isScrolledDown(event.target, sheet),
            }
          : null;
    };

    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (!(start && touch)) {
        return;
      }
      const dy = touch.clientY - start.y;
      if (Math.abs(dy) < Math.abs(touch.clientX - start.x)) {
        return;
      }
      if (!expandedRef.current && dy <= -EXPAND_DISTANCE) {
        start = null;
        setExpanded(true);
      } else if (
        expandedRef.current &&
        !start.scrolled &&
        dy >= COLLAPSE_DISTANCE &&
        !isScrolledDown(event.target, sheet)
      ) {
        start = null;
        setExpanded(false);
      }
    };

    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) {
        return;
      }
      if (!expandedRef.current && event.deltaY > 0) {
        setExpanded(true);
        return;
      }
      if (!expandedRef.current || event.deltaY >= 0) {
        return;
      }
      if (isScrolledDown(event.target, sheet)) {
        lastScrolledWheel = event.timeStamp;
      } else if (event.timeStamp - lastScrolledWheel > WHEEL_SETTLE_MS) {
        setExpanded(false);
      }
    };

    const onTouchEnd = (): void => {
      start = null;
    };

    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    sheet.addEventListener("touchmove", onTouchMove, { passive: true });
    sheet.addEventListener("touchend", onTouchEnd, { passive: true });
    sheet.addEventListener("touchcancel", onTouchEnd, { passive: true });
    sheet.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      sheet.removeEventListener("touchstart", onTouchStart);
      sheet.removeEventListener("touchmove", onTouchMove);
      sheet.removeEventListener("touchend", onTouchEnd);
      sheet.removeEventListener("touchcancel", onTouchEnd);
      sheet.removeEventListener("wheel", onWheel);
    };
  }, [sheet, expandedRef, setExpanded]);
}

/**
 * Keeps --sheet-viewport (visible height) and --sheet-keyboard (what an
 * on-screen keyboard covers) on the sheet, for its full screen size.
 */
export function useSheetViewport(content: HTMLElement | null): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!(content && viewport)) {
      return;
    }
    const update = (): void => {
      // Pinch-zoom shrinks the visual viewport too; only a keyboard counts.
      const zoomed = viewport.scale > 1;
      const height = zoomed ? window.innerHeight : viewport.height;
      const covered = window.innerHeight - height - viewport.offsetTop;
      content.style.setProperty("--sheet-viewport", `${height}px`);
      content.style.setProperty(
        "--sheet-keyboard",
        `${zoomed ? 0 : Math.max(0, covered)}px`
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [content]);
}
