"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// Upward travel that opens the sheet full screen; downward travel at the top
// of the content that brings it back.
const EXPAND_DISTANCE = 16;
const COLLAPSE_DISTANCE = 48;
// Wheel-up ticks closer together than this (trackpad momentum) never collapse.
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
 * Whether a bottom sheet is full screen. Swipe up or wheel down opens it full
 * screen; swipe down or wheel up while its content is at the top brings it
 * back to its own height. The ref follows the state for listeners and layout
 * effects that must not wait for a render.
 */
export function useSheetExpand(
  sheet: HTMLElement | null
): [boolean, (expanded: boolean) => void, RefObject<boolean>] {
  const [expanded, setExpandedState] = useState(false);
  const expandedRef = useRef(false);
  const setExpanded = useCallback((next: boolean): void => {
    expandedRef.current = next;
    setExpandedState(next);
  }, []);

  useEffect(() => {
    if (!sheet) {
      return;
    }
    let start: { x: number; y: number; scrolled: boolean } | null = null;
    let lastWheelUp = 0;

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
      const sincePrevious = event.timeStamp - lastWheelUp;
      lastWheelUp = event.timeStamp;
      if (
        sincePrevious > WHEEL_SETTLE_MS &&
        !isScrolledDown(event.target, sheet)
      ) {
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
  }, [sheet, setExpanded]);

  return [expanded, setExpanded, expandedRef];
}

/**
 * Keeps --sheet-viewport (visible height) and --sheet-keyboard (what an
 * on-screen keyboard covers) on Vaul's Content, which sizes the sheet.
 */
export function useSheetViewport(content: HTMLElement | null): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!(content && viewport)) {
      return;
    }
    let written = "";
    const update = (): void => {
      // Pinch-zoom shrinks the visual viewport too; only a keyboard counts.
      const zoomed = viewport.scale > 1;
      const layout = document.documentElement.clientHeight;
      const height = zoomed ? layout : viewport.height;
      const covered = zoomed
        ? 0
        : Math.max(0, layout - height - viewport.offsetTop);
      // iOS fires scroll every frame while the page pans; write only changes.
      const next = `${height}/${covered}`;
      if (next === written) {
        return;
      }
      written = next;
      content.style.setProperty("--sheet-viewport", `${height}px`);
      content.style.setProperty("--sheet-keyboard", `${covered}px`);
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
